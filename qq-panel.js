/**
 * Turn DSH sessions into QQ 指令面板 items.
 *
 * Pure and transport-free so the layout rules can be tested offline.
 *
 * Why a panel instead of one message per session: the panel is a native QQ
 * surface outside the chat transcript. It answers "where is #4 now?" without
 * adding a single line to the conversation, which is exactly the part message
 * flooding breaks.
 *
 * Platform limits this module obeys:
 *   - at most 20 items per panel
 *   - `name`  <= 14 display columns (~7 CJK), and for `type=command` it is the
 *     literal text dropped into the chat input box — so it must be a command
 *   - `desc`  <= 30 display columns (~15 CJK)
 *
 * Display width counts East-Asian wide characters and emoji as 2 columns.
 */

/** Platform hard limits. */
export const PANEL_ITEM_LIMIT = 20
export const PANEL_NAME_LIMIT = 14
export const PANEL_DESC_LIMIT = 30

/** Marks the panel as ours when scanning `GET /v2/panels`. */
export const PANEL_REMARK = 'dsh-notify-toast/sessions'

/** Session states, most urgent first. `cold` is a subscribed session with no agent. */
const STATE_RANK = {
  approval: 0,
  question: 0,
  error: 1,
  blocked: 1,
  interrupted: 1,
  running: 2,
  completed: 3,
  idle: 4,
  cold: 5,
}

const STATE_BADGE = {
  approval: '⚠ 待审批',
  question: '❓ 待回答',
  error: '❌ 失败',
  blocked: '⏸ 已阻塞',
  interrupted: '⏹ 已中断',
  running: '▶ 运行中',
  completed: '✅ 完成',
  idle: '·',
  cold: '💤 未打开',
}

/** East-Asian wide / fullwidth / emoji ranges, each 2 columns in QQ. */
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
  [0x2300, 0x23ff],
  [0x2500, 0x27bf],
  [0x2b00, 0x2bff],
]

function isWide(codePoint) {
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) return true
  }
  return false
}

/** Display columns of a string as QQ counts them. */
export function displayWidth(text) {
  let width = 0
  for (const char of String(text ?? '')) {
    const codePoint = char.codePointAt(0)
    width += codePoint !== undefined && isWide(codePoint) ? 2 : 1
  }
  return width
}

/** Truncate to a display-column budget, appending `…` when anything was cut. */
export function clipWidth(text, limit) {
  const value = String(text ?? '')
  const budgetLimit = Math.max(0, Number(limit) || 0)
  if (displayWidth(value) <= budgetLimit) return value
  const ellipsis = '…'
  const ellipsisWidth = displayWidth(ellipsis)
  const budget = budgetLimit - ellipsisWidth
  if (budget <= 0) return ellipsis

  let out = ''
  let width = 0
  for (const char of value) {
    const codePoint = char.codePointAt(0)
    const charWidth = codePoint !== undefined && isWide(codePoint) ? 2 : 1
    if (width + charWidth > budget) break
    out += char
    width += charWidth
  }
  return out.trimEnd() + ellipsis
}

/** Badge for one session state, defaulting to the idle marker. */
export function stateBadge(state) {
  return STATE_BADGE[state] ?? STATE_BADGE.idle
}

function rankOf(state) {
  return STATE_RANK[state] ?? STATE_RANK.idle
}

/**
 * Build the item list for one panel.
 *
 * Ordering is by urgency, not by alias: whatever needs the user first shows up
 * first, since a panel is scannable but not searchable. The two utility entries
 * are always last and always present when there is room.
 *
 * @param {Array<{ alias: number, title: string, state: string }>} rows
 * @param {{ limit?: number, includeUtility?: boolean }} [options]
 * @returns {Array<{ type: 'command', name: string, desc: string }>}
 */
export function buildPanelItems(rows, { limit = PANEL_ITEM_LIMIT, includeUtility = true } = {}) {
  const cap = Math.max(0, Math.min(PANEL_ITEM_LIMIT, Number(limit) || 0))
  const ordered = [...(Array.isArray(rows) ? rows : [])]
    .filter((row) => row && Number.isInteger(row.alias) && row.alias > 0)
    .sort((a, b) => rankOf(a.state) - rankOf(b.state) || a.alias - b.alias)

  const utility = includeUtility
    ? [
        { type: 'command', name: '/ls', desc: '全部会话与状态' },
        { type: 'command', name: '/status', desc: 'QQ 通道状态' },
      ]
    : []
  const room = Math.max(0, cap - utility.length)

  const items = ordered.slice(0, room).map((row) => ({
    type: 'command',
    // Tapping a `command` item inserts `name` verbatim, so it has to be a
    // complete command rather than a label.
    name: clipWidth(`/s ${row.alias}`, PANEL_NAME_LIMIT),
    desc: clipWidth(`${stateBadge(row.state)} ${row.title || '新对话'}`, PANEL_DESC_LIMIT),
  }))

  for (const item of utility) {
    if (items.length >= cap) break
    items.push({ ...item, name: clipWidth(item.name, PANEL_NAME_LIMIT), desc: clipWidth(item.desc, PANEL_DESC_LIMIT) })
  }
  return items
}

/** One panel payload (`panel` field of POST/PUT /v2/panels). */
export function buildPanelPayload(rows, options) {
  return { items: buildPanelItems(rows, options), remark: PANEL_REMARK }
}

/**
 * Smallest alias number nobody is using.
 *
 * Numbers are recycled: turning a session's QQ switch off frees its number and
 * the next subscription takes the lowest free one. Aliases are only ever read
 * from the current subscription table, so a recycled number can never deliver
 * to the previous owner's session.
 *
 * @param {Iterable<number>} taken
 */
export function allocateAlias(taken) {
  const used = new Set()
  for (const value of taken ?? []) {
    const number = Number(value)
    if (Number.isInteger(number) && number > 0) used.add(number)
  }
  let next = 1
  while (used.has(next)) next += 1
  return next
}

/**
 * Normalize any state file this plugin has ever written into the v3 shape.
 *
 * v2 kept `aliases` and `subscriptions` as two tables, which drifted apart:
 * a session could hold an alias without being subscribed (the `/ls` side
 * effect). v3 makes the subscription the only truth, so alias-only entries are
 * dropped here — that is what retires the stale numbers after an upgrade.
 *
 * @param {any} raw parsed `state.json`
 * @returns {{ version: number, subscriptions: Record<string, { alias: number, since: number, title: string }>, learnedOpenids: string[], panelId: string, closed: { labels: Record<string, string[]>, refs: string[] } }}
 */
export function migrateQQState(raw) {
  const data = raw && typeof raw === 'object' ? raw : {}
  const rawSubscriptions = data.subscriptions && typeof data.subscriptions === 'object'
    ? data.subscriptions
    : {}
  const rawAliases = data.aliases && typeof data.aliases === 'object' ? data.aliases : {}

  const collected = []
  for (const [sessionId, value] of Object.entries(rawSubscriptions)) {
    if (!sessionId) continue
    const entry = value && typeof value === 'object' ? value : {}
    if (entry.on === false) continue
    const fromEntry = Number(entry.alias)
    const fromTable = Number(rawAliases[sessionId])
    collected.push({
      sessionId,
      alias: Number.isInteger(fromEntry) && fromEntry > 0
        ? fromEntry
        : Number.isInteger(fromTable) && fromTable > 0
          ? fromTable
          : 0,
      since: Number(entry.since) > 0 ? Number(entry.since) : 0,
      lastLiveAt: Number(entry.lastLiveAt) > 0 ? Number(entry.lastLiveAt) : 0,
      title: typeof entry.title === 'string' ? entry.title : '',
    })
  }

  const subscriptions = {}
  const used = new Set()
  for (const item of collected) {
    let alias = item.alias
    if (alias <= 0 || used.has(alias)) alias = allocateAlias(used)
    used.add(alias)
    subscriptions[item.sessionId] = {
      alias,
      since: item.since,
      lastLiveAt: item.lastLiveAt,
      title: item.title,
    }
  }

  // Cards cannot be recalled, so the record of what already closed has to
  // outlive a reload: it is the only thing that refuses a stale chip tap.
  const rawClosed = data.closed && typeof data.closed === 'object' ? data.closed : {}
  const rawLabels = rawClosed.labels && typeof rawClosed.labels === 'object' ? rawClosed.labels : {}
  const labels = {}
  for (const [sessionId, values] of Object.entries(rawLabels)) {
    if (!sessionId || !Array.isArray(values)) continue
    const kept = values.filter((value) => typeof value === 'string' && value)
    if (kept.length > 0) labels[sessionId] = kept
  }
  const refs = Array.isArray(rawClosed.refs)
    ? rawClosed.refs.filter((value) => typeof value === 'string' && value)
    : []

  return {
    version: 3,
    subscriptions,
    learnedOpenids: Array.isArray(data.learnedOpenids)
      ? data.learnedOpenids.filter((value) => typeof value === 'string' && value)
      : [],
    panelId: typeof data.panelId === 'string' ? data.panelId : '',
    closed: { labels, refs },
  }
}

/**
 * Subscriptions that have been cold for longer than the TTL.
 *
 * DSH has no "delete session" action — a session can only be archived, and
 * deleting a workspace explicitly keeps its sessions. So a subscription never
 * needs to be retired because its session vanished; it is retired because
 * nobody touched it for long enough. That keeps the plugin free of any
 * assumption about the session store layout.
 *
 * A row whose timestamp is unknown is kept: silently dropping a subscription
 * is worse than keeping a stale one for another day.
 *
 * @param {Array<{ sessionId: string, live?: boolean, lastLiveAt?: number, since?: number }>} rows
 * @param {number} now
 * @param {number} ttlMs  0 or less disables the sweep entirely
 */
export function selectStaleSubscriptions(rows, now, ttlMs) {
  if (!(Number(ttlMs) > 0)) return []
  const cutoff = Number(now) - Number(ttlMs)
  const out = []
  for (const row of rows ?? []) {
    if (!row || !row.sessionId || row.live === true) continue
    const lastLiveAt = Number(row.lastLiveAt) > 0 ? Number(row.lastLiveAt) : 0
    const since = Number(row.since) > 0 ? Number(row.since) : 0
    const stamp = lastLiveAt || since
    if (stamp > 0 && stamp < cutoff) out.push(row.sessionId)
  }
  return out
}

/** Cheap change detector so unchanged boards are never re-pushed. */
export function panelSignature(items) {
  return JSON.stringify(Array.isArray(items) ? items : [])
}

/**
 * `#3 · 修复登录超时` — the identity of one session inside one QQ chat.
 *
 * Every notification card and every `/s` reply starts with this line, which is
 * what makes a wall of cards attributable without scrolling.
 */
export function cardAnchor(alias, title) {
  const name = title || '新对话'
  const number = Number(alias)
  return Number.isInteger(number) && number > 0 ? `#${number} · ${name}` : name
}

/**
 * First line of a card: `✅ **#3 · 修复登录超时** · 会话完成`.
 *
 * The status emoji leads so a notification list is still scannable, and the
 * anchor follows so each line says which session it belongs to.
 */
export function formatCardHeader(emoji, alias, title, suffix) {
  const head = `${emoji ? `${emoji} ` : ''}**${cardAnchor(alias, title)}**`
  return suffix ? `${head} · ${suffix}` : head
}
