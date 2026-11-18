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

/** Session states, most urgent first. `idle` is the fallback. */
const STATE_RANK = {
  approval: 0,
  question: 0,
  error: 1,
  blocked: 1,
  interrupted: 1,
  running: 2,
  completed: 3,
  idle: 4,
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
