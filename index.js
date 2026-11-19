/**
 * Host half: watches session/approval events, drives the standalone notifier
 * process over NDJSON, and relays "user clicked a card" to the page over SSE.
 */
import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createQQBotLite, isPanelGone } from './qqbot-lite/index.js'
import {
  allocateAlias,
  buildPanelItems,
  formatCardHeader,
  migrateQQState,
  panelSignature,
  selectStaleSubscriptions,
  stateBadge,
  PANEL_ITEM_LIMIT,
  PANEL_REMARK,
} from './qq-panel.js'
import { fitMessage, pendingReplyText, summarizeUsage, turnReplyText, turnStartSeq } from './qq-reply.js'
import {
  extractRefIdx,
  parseApprovalOutcome,
  parseQuestionAnswer,
  selectInboundRoute,
} from './qq-answer.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Profiles install this bundle as a link outside the dsh tree, so a bare
 * specifier cannot see the dsh installation. Resolve the framework's own
 * schemastery from the Host entry script instead, loading the same ESM file
 * URL the framework uses so both sides share one module instance.
 */
async function loadSchemaLib() {
  const bases = []
  try { if (process.argv[1]) bases.push(process.argv[1]) } catch {}
  bases.push(fileURLToPath(import.meta.url))
  for (const base of bases) {
    try {
      const req = createRequire(base)
      const pkgPath = req.resolve('@deepseek-ai/schemastery/package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const exp = pkg.exports && pkg.exports['.']
      const entry = typeof exp === 'string' ? exp : exp && (exp.import || exp.default)
      if (!entry) continue
      const url = pathToFileURL(path.join(path.dirname(pkgPath), entry)).href
      const mod = await import(url)
      const lib = mod.default || mod
      if (lib && typeof lib.object === 'function') return lib
    } catch {}
  }
  for (const base of bases) {
    try {
      const req = createRequire(base)
      const lib = req('@deepseek-ai/schemastery')
      const resolved = lib && lib.default ? lib.default : lib
      if (resolved && typeof resolved.object === 'function') return resolved
    } catch {}
  }
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const lib = mod.default || mod
    if (lib && typeof lib.object === 'function') return lib
  } catch {}
  return null
}

const z = await loadSchemaLib()

/**
 * Load `createUserMessage` from the harness package.
 *
 * A `link:` install cannot resolve bare dsh specifiers from its own real path,
 * so resolve the package through the Host entry script (same trick as the
 * schema library above) and import the exact ESM file the Host uses — both
 * sides then share one module instance.
 *
 * @returns {Promise<(input: { content: any[], source: object }) => any>}
 */
let createUserMessageFactory = null
async function loadCreateUserMessage() {
  if (createUserMessageFactory) return createUserMessageFactory
  const bases = []
  try { if (process.argv[1]) bases.push(process.argv[1]) } catch {}
  try {
    if (process.env.DSH_INSTALL_DIR) bases.push(path.join(process.env.DSH_INSTALL_DIR, 'index.js'))
  } catch {}
  bases.push(fileURLToPath(import.meta.url))
  for (const base of bases) {
    try {
      const req = createRequire(base)
      const pkgPath = req.resolve('@deepseek-ai/dsh-llm/package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const exported = pkg.exports && pkg.exports['.']
      const entry = typeof exported === 'string' ? exported : exported && (exported.import || exported.default)
      if (!entry) continue
      const url = pathToFileURL(path.join(path.dirname(pkgPath), entry)).href
      const mod = await import(url)
      const fn = mod.createUserMessage ?? (mod.default && mod.default.createUserMessage)
      if (typeof fn === 'function') {
        createUserMessageFactory = fn
        return fn
      }
    } catch {}
  }
  throw new Error('无法加载 @deepseek-ai/dsh-llm 的 createUserMessage')
}

export const inject = ['subprocess', 'sessions', 'webServer']

const DEFAULTS = {
  enabled: true,
  notifyOnComplete: true,
  notifyOnApproval: true,
  notifyOnQuestion: true,
  notifyOnError: false,

  soundEnabled: true,
  soundComplete: 'sounds/bubble-1.wav',
  soundApproval: 'sounds/alert-1.wav',
  soundQuestion: 'sounds/alert-2.wav',
  soundError: 'sounds/alert-3.wav',
  customSoundComplete: '',
  customSoundApproval: '',
  customSoundQuestion: '',
  customSoundError: '',

  width: 400,
  height: 104,
  scale: 1.0,
  margin: 16,
  gap: 8,
  maxCards: 4,
  durationMs: 8000,
  position: 'bottom-right',
  approvalPosition: 'bottom-right',
  screen: 'primary',

  bgColor: '#FFFFFF',
  borderColor: '#000000',
  titleColor: '#111111',
  subtitleColor: '#787878',
  accentComplete: '#16A34A',
  accentApproval: '#D97706',
  accentError: '#DC2626',
  accentQuestion: '#111111',
  iconStyle: 'vector',
  iconComplete: '',
  iconApproval: '',
  iconError: '',
  iconQuestion: '',
  fontFamily: 'Microsoft YaHei UI',

  settleMs: 1500,
  minIntervalMs: 3000,
  showElapsed: true,
  clickToOpenSession: true,
  idleExitMs: 900000,
  debug: false,

  // ---- QQ notification channel (optional) --------------------------------
  qqEnabled: false,
  qqAppId: '',
  qqAppSecret: '',
  qqOpenids: '',
  qqNotifyOnComplete: true,
  qqNotifyOnError: true,
  qqMinIntervalMs: 30000,
  qqAnswerApprovals: false,
  qqAnswerQuestions: false,
  qqAutoResume: false,
  qqPanelEnabled: true,
  qqSubscriptionTtlDays: 30,
  qqNotifyReply: false,
}

const BOOL_KEYS = [
  'enabled', 'notifyOnComplete', 'notifyOnApproval', 'notifyOnQuestion', 'notifyOnError',
  'soundEnabled', 'showElapsed', 'clickToOpenSession', 'debug',
  'qqEnabled', 'qqNotifyOnComplete', 'qqNotifyOnError',
  'qqAnswerApprovals', 'qqAnswerQuestions', 'qqAutoResume', 'qqPanelEnabled', 'qqNotifyReply',
]
// `qqAutoResume` is kept in the schema so existing profiles still load, but it
// no longer gates anything: since a subscribed session can be cold after a
// restart, delivering to one always resumes it.
const NUM_KEYS = [
  'width', 'height', 'scale', 'margin', 'gap', 'maxCards', 'durationMs',
  'settleMs', 'minIntervalMs', 'idleExitMs', 'qqMinIntervalMs', 'qqSubscriptionTtlDays',
]

/** QQ channel runtime files live outside the bundle, next to the user's home. */
const QQ_DATA_DIR = path.join(homedir(), '.dsh-notify-toast')
const QQ_STATE_FILE = path.join(QQ_DATA_DIR, 'state.json')
const QQ_LOCK_FILE = path.join(QQ_DATA_DIR, 'qqbot.lock')

/** A passive reply anchor is only usable for 60 minutes and 4 replies. */
const PASSIVE_WINDOW_MS = 55 * 60 * 1000
const PASSIVE_MAX_REPLIES = 4
/**
 * Proactive-send failures that a passive reply can still rescue: no permission
 * for proactive messages, proactive rate limit, and the user turning active
 * sends off. Anything else (network, auth) would just fail twice.
 */
const FALLBACK_CODES = new Set([40034100, 40034105, 40054013])
/** QQ rejects an over-long message with this code; retrying shorter beats losing it. */
const TOO_LONG_CODES = new Set([40054007])
/** Head+tail budget used only after the platform has already refused a card. */
const MAX_CARD_CHARS = 3000
/** Panel writes are 10 QPM, so never push them closer than this. */
const PANEL_WRITE_GAP_MS = 7000
/** Coalesce bursts of session events into one panel refresh. */
const PANEL_SYNC_DEBOUNCE_MS = 4000

function schema() {
  if (!z) return undefined
  const shape = {}
  for (const [key, value] of Object.entries(DEFAULTS)) {
    // Volatile fields are what the settings service projects into a live form;
    // without it `volatileForm()` returns undefined and no page is generated.
    if (BOOL_KEYS.includes(key)) shape[key] = z.boolean().default(value).volatile()
    else if (NUM_KEYS.includes(key)) shape[key] = z.number().default(value).volatile()
    else shape[key] = z.string().default(value).volatile()
  }
  return z.object(shape)
}

export const Config = schema()

function pick(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value.get === 'function') {
    try {
      const next = value.get()
      return next === undefined || next === null ? fallback : next
    } catch {
      return fallback
    }
  }
  return value
}

function resolveConfig(config) {
  const out = {}
  for (const key of Object.keys(DEFAULTS)) out[key] = pick(config?.[key], DEFAULTS[key])
  return out
}

function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return total + ' 秒'
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s === 0 ? m + ' 分钟' : m + ' 分 ' + s + ' 秒'
  const h = Math.floor(m / 60)
  return h + ' 小时 ' + (m % 60) + ' 分'
}

/** "12 秒" / "3 分钟" — how long ago a status was last touched. */
function fmtRelative(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000))
  if (seconds < 60) return seconds + ' 秒'
  if (seconds < 3600) return Math.round(seconds / 60) + ' 分钟'
  return Math.round(seconds / 3600) + ' 小时'
}

/**
 * The start time of the turn that the event at `beforeSeq` closes, read back
 * from the session log. Process memory is lost on every plugin reload, so the
 * durable log is the only place the answer survives.
 */
function turnStartTimeOf(session, beforeSeq) {
  try {
    const end = Number(beforeSeq)
    if (!Number.isFinite(end)) return undefined
    const floor = Math.max(0, end - 5000)
    for (let seq = end - 1; seq >= floor; seq -= 1) {
      const entry = session.eventAt(seq)
      if (!entry) continue
      if (entry.type === 'turn/start') return entry.time
      if (entry.type === 'turn/end') return undefined
    }
  } catch {}
  return undefined
}

export function apply(ctx, rawConfig) {
  const timers = new Set()
  const settleTimers = new Map()
  const lastFired = new Map()
  const sseClients = new Set()

  let child = null
  let starting = null
  let readyResolver = null
  let readyFlag = false
  let nextId = 1
  let idleTimer = null
  let pendingFocus = null
  let spawnFailures = 0

  const cfg = () => resolveConfig(rawConfig)

  const log = (...args) => {
    try {
      if (cfg().debug) console.log('[notify-toast]', ...args)
    } catch {}
  }

  function later(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      try { fn() } catch (error) { log('timer failed', error) }
    }, ms)
    timers.add(timer)
    return timer
  }

  function cancel(timer) {
    if (!timer) return
    timers.delete(timer)
    clearTimeout(timer)
  }

  function send(message) {
    if (!child || !child.stdin) return false
    try {
      child.stdin.write(JSON.stringify(message) + '\n')
      return true
    } catch (error) {
      log('write failed', error)
      return false
    }
  }

  /** Ask the notifier to leave, then reclaim it if it does not exit on its own. */
  async function shutdownChild() {
    const current = child
    child = null
    readyFlag = false
    if (!current) return
    try {
      if (current.stdin) current.stdin.write(JSON.stringify({ t: 'quit' }) + '\n')
    } catch {}
    let exited = false
    try {
      const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(2500) : undefined
      exited = await current.waitForExit(signal)
    } catch {
      exited = false
    }
    if (!exited) {
      try { current.terminate() } catch {}
    }
  }

  function resetIdle() {
    if (idleTimer) { clearTimeout(idleTimer); timers.delete(idleTimer); idleTimer = null }
    const ms = Math.max(30000, Number(cfg().idleExitMs) || 900000)
    idleTimer = later(() => {
      idleTimer = null
      if (!child) return
      log('idle exit')
      void shutdownChild()
    }, ms)
  }

  function handleLine(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (!message || typeof message !== 'object') return
    if (message.t === 'ready') {
      if (readyResolver) { const resolve = readyResolver; readyResolver = null; resolve(true) }
      return
    }
    if (message.t === 'error') {
      log('notifier error', message.message)
      return
    }
    if (message.t === 'click') {
      if (!message.sessionId) return
      pendingFocus = { sessionId: message.sessionId, at: Date.now() }
      broadcast({ type: 'focus', sessionId: message.sessionId })
      log('click', message.sessionId)
      return
    }
    if (message.t === 'closed' || message.t === 'shown') {
      log(message.t, message.id, message.reason || '')
    }
  }

  function startChild() {
    if (child && readyFlag) return Promise.resolve(child)
    if (starting) return starting
    starting = (async () => {
      const exe = await ctx.subprocess.resolveExecutable('powershell.exe')
      const script = path.join(here, 'notifier', 'notifier.ps1')
      const handle = ctx.subprocess.spawn({
        argv: [exe, '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-NotifyHost'],
        cwd: here,
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: 2000,
      })
      child = handle

      let buffer = ''
      if (handle.stdout) {
        handle.stdout.setEncoding('utf8')
        handle.stdout.on('data', (chunk) => {
          buffer += chunk
          let index
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim()
            buffer = buffer.slice(index + 1)
            if (line) handleLine(line)
          }
        })
      }

      const ready = new Promise((resolve) => { readyResolver = resolve })
      handle.done.then(() => {
        child = null
        readyFlag = false
        log('notifier exited')
      }).catch(() => {
        child = null
        readyFlag = false
      })

      const timeout = setTimeout(() => {
        if (readyResolver) { const resolve = readyResolver; readyResolver = null; resolve(false) }
      }, 8000)

      const ok = await ready
      clearTimeout(timeout)
      if (!ok) {
        try { handle.terminate() } catch {}
        child = null
        readyFlag = false
        throw new Error('notifier did not become ready in 8s')
      }
      readyFlag = true
      send({ t: 'init', cfg: { ...cfg(), baseDir: here } })
      resetIdle()
      return handle
    })()

    starting.then(() => { starting = null }, () => { starting = null })
    return starting
  }

  function show(card) {
    const current = cfg()

    if (!current.enabled) return
    const id = 'n' + (nextId++)
    startChild().then(() => {

      send({
        t: 'show',
        id,
        kind: card.kind,
        title: card.title,
        subtitle: card.subtitle,
        sessionId: card.sessionId || '',
        durationMs: current.durationMs,
        sound: card.sound || '',
        cfg: current,
      })
      spawnFailures = 0
      resetIdle()
    }).catch((error) => {
      spawnFailures += 1

      if (spawnFailures <= 3) {
        console.warn('[notify-toast] popup failed:', error && error.message ? error.message : error)
      }
    })
  }

  function titleOf(session) {
    try {
      const service = ctx.get('sessionTitle')
      if (service && typeof service.get === 'function') {
        const snapshot = service.get(session)
        if (snapshot && snapshot.title) return snapshot.title
      }
    } catch {}
    try {
      const cwd = session?.header?.cwd
      if (cwd) return path.basename(cwd)
    } catch {}
    return '新对话'
  }

  /**
   * Stable anchor for one session: `#3 · 修复登录超时`.
   *
   * One QQ conversation carries every session, so the alias belongs in the
   * first line of every card. Without it a wall of notifications is anonymous
   * and the only way back is scrolling.
   */
  function cardHeader(emoji, sessionId, title, suffix) {
    const entry = qqSubscriptions.get(sessionId)
    return formatCardHeader(emoji, entry ? entry.alias : 0, title, suffix)
  }

  function broadcast(payload) {
    const data = 'data: ' + JSON.stringify(payload) + '\n\n'
    for (const response of sseClients) {
      try { response.write(data) } catch { sseClients.delete(response) }
    }
  }

  // ---- QQ channel ---------------------------------------------------------
  //
  // The QQ bot is an independent AppID with its own gateway connection, so it
  // never touches the dsh-qqbot conversation bot. Only sessions whose per
  // session switch is on push notifications; the switch is stored outside the
  // bundle so it survives plugin reloads and page refreshes.

  /** @type {{ bot: any, stop: () => void } | null} */
  let qq = null
  let qqStatus = { state: 'disabled', detail: '' }
  /** sessionId -> { alias, since, title }. The single source of QQ visibility. */
  const qqSubscriptions = new Map()
  const lastQQFired = new Map()
  /** ref_idx of a notification card -> the session it describes (for quoted-reply routing). */
  const sentCards = new Map()
  /** openids learned from inbound messages (fallback when config is empty). */
  let qqLearned = []
  let qqStateTimer = null
  let qqLockHeld = false

  /**
   * sessionId -> { state, at }. Memory only: after a reload the state is
   * recomputed from the live agent list plus the parked-decision maps.
   */
  const sessionStates = new Map()
  /** openid -> { msgId, at, used } — the freshest passive-reply anchor. */
  const inboundAnchors = new Map()
  /** The single c2c 指令面板 that doubles as the session board. */
  let qqPanelId = ''
  let qqPanelTimer = null
  let qqPanelSignature = ''
  let qqPanelLastWrite = 0

  const MAX_SENT_CARDS = 200

  function rememberSentCard(refIdx, sessionId) {
    if (!refIdx || !sessionId) return
    sentCards.delete(refIdx)
    sentCards.set(refIdx, sessionId)
    if (sentCards.size > MAX_SENT_CARDS) {
      const oldest = sentCards.keys().next().value
      if (oldest !== undefined) sentCards.delete(oldest)
    }
  }

  function loadQQState() {
    qqSubscriptions.clear()
    qqLearned = []
    qqPanelId = ''
    try {
      if (!existsSync(QQ_STATE_FILE)) return
      const migrated = migrateQQState(JSON.parse(readFileSync(QQ_STATE_FILE, 'utf8')))
      for (const [sessionId, entry] of Object.entries(migrated.subscriptions)) {
        qqSubscriptions.set(sessionId, entry)
      }
      qqLearned = migrated.learnedOpenids
      qqPanelId = migrated.panelId
    } catch (error) {
      log('qq state load failed', error)
    }
  }

  function flushQQState() {
    try {
      mkdirSync(QQ_DATA_DIR, { recursive: true })
      // One table: a subscription *is* the alias, the switch and the title.
      const payload = {
        version: 3,
        subscriptions: Object.fromEntries(qqSubscriptions),
        learnedOpenids: qqLearned,
        panelId: qqPanelId,
      }
      const temporary = `${QQ_STATE_FILE}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(temporary, QQ_STATE_FILE)
    } catch (error) {
      log('qq state write failed', error)
    }
  }

  function persistQQStateSoon() {
    if (qqStateTimer) clearTimeout(qqStateTimer)
    qqStateTimer = later(() => {
      qqStateTimer = null
      flushQQState()
    }, 300)
  }

  /** Live agents keyed by session id (subagent sessions excluded). */
  function liveAgents() {
    const agents = agentsOf()
    const list = agents && typeof agents.list === 'function' ? agents.list() : []
    const map = new Map()
    for (const agent of list) {
      const session = agent && agent.session
      if (!session || !session.id) continue
      if (session.header && session.header.origin === 'subagent') continue
      map.set(session.id, agent)
    }
    return map
  }

  function safeTitle(session) {
    try {
      return titleOf(session) || ''
    } catch {
      return ''
    }
  }

  /** Smallest number nobody holds; a closed switch gives its number back. */
  function nextAlias() {
    return allocateAlias([...qqSubscriptions.values()].map((entry) => entry.alias))
  }

  /**
   * Turn the QQ switch on or off.
   *
   * On: allocate the lowest free alias, remember the title (the session is
   * live right now — that is the only moment it is guaranteed to be), start
   * forwarding. Off: release the alias and everything hanging off it.
   */
  function subscribeQQ(sessionId, enabled) {
    const existing = qqSubscriptions.get(sessionId)
    if (enabled) {
      if (existing) return existing.alias
      const agent = liveAgents().get(sessionId)
      const alias = nextAlias()
      qqSubscriptions.set(sessionId, {
        alias,
        since: Date.now(),
        lastLiveAt: Date.now(),
        title: agent && agent.session ? safeTitle(agent.session) : '',
      })
      persistQQStateSoon()
      // The board is built from subscriptions, so the toggle itself has to
      // schedule the refresh — no later event is guaranteed to arrive.
      schedulePanelSync()
      return alias
    }
    if (!existing) return 0
    qqSubscriptions.delete(sessionId)
    releaseParkedDecision(sessionId)
    sessionStates.delete(sessionId)
    persistQQStateSoon()
    schedulePanelSync()
    return 0
  }

  /**
   * Release a parked approval/question before dropping its session.
   *
   * Without this the waiting tool call would hang forever: the promise that
   * the agent is blocked on belongs to us and would never settle.
   */
  function releaseParkedDecision(sessionId) {
    const approval = pendingApprovals.get(sessionId)
    if (approval) {
      pendingApprovals.delete(sessionId)
      if (approval.onAbort && approval.request.signal) {
        approval.request.signal.removeEventListener('abort', approval.onAbort)
      }
      approval.resolve('cancelled')
    }
    const question = pendingQuestions.get(sessionId)
    if (question) {
      pendingQuestions.delete(sessionId)
      if (question.onAbort && question.request.signal) {
        question.request.signal.removeEventListener('abort', question.onAbort)
      }
      const error = new Error('QQ notifications were turned off before the question was answered')
      error.code = 'ASK_ABORTED'
      question.reject(error)
    }
  }

  function qqGlobalState() {
    const current = cfg()
    return {
      enabled: Boolean(current.qqEnabled),
      state: qqStatus.state,
      detail: qqStatus.detail,
      connected: qqStatus.state === 'ready',
      appId: current.qqAppId || '',
      targets: qqTargets(),
    }
  }

  function qqSessionState(sessionId) {
    const entry = qqSubscriptions.get(sessionId)
    return { sessionId, on: Boolean(entry), alias: entry ? entry.alias : 0 }
  }

  /** Configured openids, or whoever talked to the bot first. */
  function qqTargets() {
    const configured = String(cfg().qqOpenids ?? '')
      .split(/[\s,;，；]+/)
      .map((value) => value.trim())
      .filter(Boolean)
    return configured.length > 0 ? configured : qqLearned
  }

  function pidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  function releaseQQLock() {
    if (!qqLockHeld) return
    qqLockHeld = false
    try { unlinkSync(QQ_LOCK_FILE) } catch { /* already gone */ }
  }

  /** Only one host process may hold the gateway for one AppID. */
  function acquireQQLock(appId) {
    try {
      if (existsSync(QQ_LOCK_FILE)) {
        const lock = JSON.parse(readFileSync(QQ_LOCK_FILE, 'utf8'))
        if (lock && Number(lock.pid) > 0 && lock.pid !== process.pid && pidAlive(Number(lock.pid))) {
          return { ok: false, reason: `另一个 DSH 进程（pid=${lock.pid}）已占用 appId=${lock.appId ?? '?'} 的通知连接` }
        }
      }
      mkdirSync(QQ_DATA_DIR, { recursive: true })
      writeFileSync(QQ_LOCK_FILE, JSON.stringify({ pid: process.pid, appId, startedAt: Date.now() }), 'utf8')
      qqLockHeld = true
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: `无法写入锁文件：${error && error.message ? error.message : error}` }
    }
  }

  function setQQStatus(state, detail) {
    qqStatus = { state, detail: detail ?? '' }
    broadcast({ type: 'qq-status', ...qqGlobalState() })
  }

  function stopQQBridge() {
    if (qqPanelTimer) {
      cancel(qqPanelTimer)
      qqPanelTimer = null
    }
    qqPanelSignature = ''
    if (qq) {
      try { qq.stop() } catch (error) { log('qq stop failed', error) }
      qq = null
    }
    releaseQQLock()
    if (qqStatus.state !== 'disabled') setQQStatus('disabled', '')
  }

  function startQQBridge() {
    const current = cfg()
    if (!current.qqEnabled) {
      setQQStatus('disabled', '')
      return
    }
    if (!current.qqAppId || !current.qqAppSecret) {
      setQQStatus('unconfigured', '缺少 AppID / AppSecret')
      return
    }
    const lock = acquireQQLock(current.qqAppId)
    if (!lock.ok) {
      log('qq bridge locked', lock.reason)
      setQQStatus('locked', lock.reason)
      return
    }

    const bot = createQQBotLite({
      appId: current.qqAppId,
      clientSecret: current.qqAppSecret,
      logger: {
        info: (message) => log(message),
        warn: (message) => console.warn('[notify-toast]', message),
        error: (message) => console.error('[notify-toast]', message),
        debug: (message) => log(message),
      },
    })

    bot.on('state', (state) => {
      setQQStatus(state.state, state.detail)
      if (state.state === 'ready') {
        pruneStaleSubscriptions()
        schedulePanelSync(1500)
      }
      if (state.state === 'fatal') {
        console.error('[notify-toast] QQ 网关致命错误:', state.detail)
      }
    })

    // Inbound routing: a reply that answers a parked approval/question is
    // consumed here; anything else gets the connection guide.
    bot.on('message', async (message) => {
      const openid = message.openid ?? message.memberOpenid
      rememberInboundAnchor(message)
      if (openid && !qqLearned.includes(openid)) {
        qqLearned.push(openid)
        persistQQStateSoon()
        broadcast({ type: 'qq-status', ...qqGlobalState() })
      }
      if (!openid || !message.msgId) return
      if (await routeInbound(message)) return
      await replyQQ(
        openid,
        message.msgId,
        [
          '**通知机器人已连接**',
          '在 DSH 会话标题栏点 **QQ** 图标，即可让该会话把通知转发到这里。',
          '支持：`#别名 内容` 投递、`/s 别名` 查看状态、`/ls` 列出会话。',
        ].join('\n'),
      )
    })

    qq = { bot, stop: () => bot.stop() }
    setQQStatus('connecting', '')
    bot.start().catch((error) => {
      const message = error && error.message ? error.message : String(error)
      setQQStatus('error', message)
      console.error('[notify-toast] QQ 网关启动失败:', message)
    })
  }

  /**
   * Append the assistant's reply under a labelled heading.
   *
   * A bare `---` renders as a hairline that is easy to miss on a phone, so the
   * break is spelled out with a bold label instead — it survives any markdown
   * renderer and says what the block below actually is.
   */
  function withBody(markdown, body, label = '本轮输出') {
    const text = typeof body === 'string' ? body.trim() : ''
    if (!text) return markdown
    return `${markdown}\n\n**📄 ${label}**\n\n${text}`
  }

  /** Session events, or an empty list when the log is unavailable. */
  function safeEvents(session) {
    try {
      const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
      return Array.isArray(events) ? events : []
    } catch {
      return []
    }
  }

  /** The assistant's own words for the turn that just ended, when enabled. */
  function turnTextSafe(events, endSeq) {
    try {
      return turnReplyText(events, endSeq)
    } catch (error) {
      log('qq reply extraction failed', error)
      return ''
    }
  }

  /** The assistant's words so far, for a decision card asked mid-turn. */
  function replyBodyPending(session) {
    if (!cfg().qqNotifyReply) return ''
    try {
      return pendingReplyText(safeEvents(session))
    } catch (error) {
      log('qq pending reply extraction failed', error)
      return ''
    }
  }

  /** `1234` -> `1.2K`, `151234567` -> `151M`. */
  function formatTokens(value) {
    const n = Number(value) || 0
    const scaled = (unit, size) => {
      const v = n / size
      return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`
    }
    if (n >= 1e9) return scaled('B', 1e9)
    if (n >= 1e6) return scaled('M', 1e6)
    if (n >= 1e3) return scaled('K', 1e3)
    return String(n)
  }

  /** `2026.11.19.22:47` — the shape asked for in the card. */
  function formatStamp(ms) {
    const date = new Date(ms)
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}.${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  /**
   * Context occupancy, straight from the service the status bar uses.
   * Returns undefined when either half of the fact is missing.
   */
  function contextUsageOf(session) {
    try {
      const meter = ctx.get('tokenMeter')
      if (!meter || typeof meter.measure !== 'function') return undefined
      const size = Number(session?.requestContext?.()?.contextWindow) || 0
      if (!(size > 0)) return undefined
      const used = Number(meter.measure(session)?.totalTokens) || 0
      if (!(used > 0)) return undefined
      return { used, size, ratio: used / size }
    } catch {
      return undefined
    }
  }

  /**
   * One line of run statistics.
   *
   * The turn figure is stated as `N tok / M 秒` rather than a tok/s number: it
   * includes thinking and tool time, so a rate would sit next to the status
   * bar's pure decode speed and look wrong by a wide margin.
   */
  function statsLine(total, context, turnSummary, turnSeconds) {
    const parts = []
    if (total.turns > 0 || total.steps > 0) parts.push(`${total.turns} 轮 ${total.steps} 步`)
    if (total.totalTokens > 0) parts.push(`${formatTokens(total.totalTokens)} tok`)
    if (total.cacheHit !== undefined) parts.push(`缓存 ${Math.round(total.cacheHit * 100)}%`)
    if (context) parts.push(`上下文 ${Math.round(context.ratio * 100)}%`)
    if (turnSummary.outputTokens > 0 && turnSeconds > 0) {
      parts.push(`本轮 ${formatTokens(turnSummary.outputTokens)} tok / ${fmtDuration(turnSeconds)}`)
    }
    return parts.length > 0 ? `📊 ${parts.join(' · ')}` : ''
  }

  /** Send one programmatic card to every target. */
  async function notifyQQ({ sessionId, emoji, suffix, title, cwd, elapsed, finishedAt, stats, detail, body }) {
    if (!qq || qqStatus.state !== 'ready') return
    const targets = qqTargets()
    if (targets.length === 0) {
      log('qq notify skipped: no target openid')
      return
    }
    const lines = [cardHeader(emoji, sessionId, title, suffix)]
    if (stats) lines.push(stats)
    if (elapsed) lines.push(`用时：${elapsed}`)
    if (finishedAt) lines.push(`结束：${finishedAt}`)
    if (cwd) lines.push(`目录：${cwd}`)
    if (detail) lines.push(detail)
    const markdown = withBody(lines.join('\n'), body)
    for (const openid of targets) {
      try {
        await sendCard(openid, { markdown, sessionId })
      } catch (error) {
        console.warn('[notify-toast] QQ 通知发送失败:', error && error.message ? error.message : error)
      }
    }
  }

  // ---- QQ delivery: proactive first, passive only as a fallback -----------
  //
  // The two message classes have very different budgets. A passive reply costs
  // 1 of 4 slots on one `msg_id` and dies 60 minutes after that message, while
  // a proactive message is 20/min per user and 1000/day. So proactive is the
  // default path and the passive anchor only rescues bots that never got the
  // "单聊主动消息" permission on the open platform.

  function rememberInboundAnchor(message) {
    const openid = message?.openid ?? message?.memberOpenid
    if (!openid || !message?.msgId) return
    inboundAnchors.set(openid, { msgId: message.msgId, at: Date.now(), used: 0 })
  }

  /** The freshest still-usable passive anchor, or undefined. */
  function passiveAnchorFor(openid) {
    const entry = inboundAnchors.get(openid)
    if (!entry) return undefined
    if (Date.now() - entry.at > PASSIVE_WINDOW_MS) return undefined
    if (entry.used >= PASSIVE_MAX_REPLIES) return undefined
    return entry
  }

  /** Send one card, preferring a proactive message over a passive reply. */
  async function sendCard(openid, { markdown, sessionId }) {
    if (!qq || !openid || !markdown) return undefined
    let sent
    try {
      sent = await sendFitted(openid, markdown)
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined
      const anchor = FALLBACK_CODES.has(code) ? passiveAnchorFor(openid) : undefined
      if (!anchor) throw error
      log(`qq proactive send rejected (${code}), retrying as a passive reply`)
      sent = await qq.bot.sendC2C(openid, { markdown, msgId: anchor.msgId })
      anchor.used += 1
    }
    // Quoting this card later routes the reply back to the same session.
    if (sent && sent.refIdx && sessionId) rememberSentCard(sent.refIdx, sessionId)
    return sent
  }

  /**
   * Send once, and if the platform says it is too long, resend a head+tail
   * cut. The card itself never pre-truncates, so a reply that fits goes out
   * whole — the cost of getting this wrong is losing the notification.
   */
  async function sendFitted(openid, markdown) {
    try {
      return await qq.bot.sendC2C(openid, { markdown })
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined
      if (!TOO_LONG_CODES.has(code)) throw error
      const fitted = fitMessage(markdown, MAX_CARD_CHARS)
      if (!fitted.truncated) throw error
      log(`qq card too long (${markdown.length} chars), retrying with ${fitted.text.length}`)
      return qq.bot.sendC2C(openid, { markdown: fitted.text })
    }
  }

  // ---- 指令面板: the session board ----------------------------------------
  //
  // The panel is a native QQ surface outside the transcript, so it can show
  // "where is #4 now" without spending a single message. This is what keeps
  // per-session notifications readable: the cards stay in the chat, the board
  // stays one tap away.

  function markSessionState(sessionId, state) {
    if (!sessionId) return
    // Re-insert so the Map stays ordered by recency and can be trimmed.
    sessionStates.delete(sessionId)
    sessionStates.set(sessionId, { state, at: Date.now() })
    while (sessionStates.size > 300) {
      const oldest = sessionStates.keys().next().value
      if (oldest === undefined) break
      sessionStates.delete(oldest)
    }
    schedulePanelSync()
  }

  /** Current state of one session, derived from live signals when possible. */
  function stateOfSession(sessionId, running) {
    for (const entry of pendingApprovals.values()) {
      if (entry.sessionId === sessionId) return 'approval'
    }
    for (const entry of pendingQuestions.values()) {
      if (entry.sessionId === sessionId) return 'question'
    }
    if (running) return 'running'
    const known = sessionStates.get(sessionId)
    return known ? known.state : 'idle'
  }

  /**
   * Rows the board shows.
   *
   * The panel is "what I care about", not a full session list: switching a
   * session's QQ toggle off takes it off the board, and a session that is
   * still running stays visible even with notifications off. `/ls` remains the
   * complete list, so nothing becomes unreachable.
   */
  function panelRows() {
    return qqVisibleSessions().map((row) => ({
      alias: row.alias,
      title: row.title,
      state: row.state,
    }))
  }

  /** Forget a session that is gone, then let the board catch up. */
  function forgetSession(sessionId) {
    if (sessionId) sessionStates.delete(sessionId)
    schedulePanelSync(500)
  }

  /** Session id out of whatever shape a lifecycle event carries. */
  function sessionIdOf(payload) {
    if (!payload) return undefined
    if (typeof payload === 'string') return payload
    if (typeof payload !== 'object') return undefined
    return payload.sessionId ?? payload.id ?? (payload.session && payload.session.id) ?? undefined
  }

  /**
   * Retire subscriptions that have been cold for longer than the TTL.
   *
   * DSH never deletes a session (it can only be archived, and deleting a
   * workspace keeps every session), so there is nothing to reconcile against
   * the store. A subscription outlives its usefulness long before the file
   * does, and a time-based sweep needs no assumption about DSH's layout.
   */
  function pruneStaleSubscriptions(now = Date.now()) {
    const days = Math.max(0, Number(cfg().qqSubscriptionTtlDays) || 0)
    const rows = [...qqSubscriptions].map(([sessionId, entry]) => ({
      sessionId,
      live: isSessionLive(sessionId),
      lastLiveAt: entry.lastLiveAt,
      since: entry.since,
    }))
    const stale = selectStaleSubscriptions(rows, now, days * 86_400_000)
    if (stale.length === 0) return
    for (const sessionId of stale) {
      qqSubscriptions.delete(sessionId)
      releaseParkedDecision(sessionId)
      sessionStates.delete(sessionId)
    }
    persistQQStateSoon()
    schedulePanelSync()
    log('retired stale subscriptions', stale.length)
  }

  /** One cheap liveness probe that does not rebuild the whole board. */
  function isSessionLive(sessionId) {
    const agents = agentsOf()
    return Boolean(agents && typeof agents.get === 'function' && agents.get(sessionId))
  }

  /** Remember that a subscription was confirmed alive, at most hourly. */
  function touchSubscription(sessionId) {
    const entry = qqSubscriptions.get(sessionId)
    if (!entry) return
    const now = Date.now()
    if (now - (entry.lastLiveAt || 0) < 3_600_000) return
    entry.lastLiveAt = now
    persistQQStateSoon()
  }

  function schedulePanelSync(delay = PANEL_SYNC_DEBOUNCE_MS) {
    if (qqPanelTimer) return
    if (!cfg().qqPanelEnabled) return
    if (!qq || qqStatus.state !== 'ready') return
    qqPanelTimer = later(() => {
      qqPanelTimer = null
      void syncPanel()
    }, Math.max(0, delay))
  }

  async function syncPanel() {
    if (!qq || qqStatus.state !== 'ready') return
    if (!cfg().qqPanelEnabled) return
    const targets = qqTargets()
    if (targets.length === 0) return

    // Panel writes are 10 QPM; anything closer is deferred, not dropped.
    const gap = PANEL_WRITE_GAP_MS - (Date.now() - qqPanelLastWrite)
    if (gap > 0) {
      schedulePanelSync(gap + 100)
      return
    }

    const items = buildPanelItems(panelRows(), { limit: PANEL_ITEM_LIMIT })
    const signature = panelSignature(items)
    if (qqPanelId && signature === qqPanelSignature) return

    qqPanelLastWrite = Date.now()
    try {
      if (!qqPanelId) {
        await findOrCreatePanel(targets, items)
      } else {
        await qq.bot.panels.update(qqPanelId, { items, remark: PANEL_REMARK })
        qqPanelSignature = signature
      }
      log('qq panel synced', items.length)
    } catch (error) {
      if (isPanelGone(error) && qqPanelId) {
        log('qq panel is gone, recreating')
        qqPanelId = ''
        try {
          await findOrCreatePanel(targets, items)
        } catch (retry) {
          log('qq panel recreate failed', retry)
        }
        return
      }
      log('qq panel sync failed', error && error.message ? error.message : error)
    }
  }

  /** Adopt the panel carrying our remark, or create one bound to the targets. */
  async function findOrCreatePanel(targets, items) {
    let records = []
    try {
      records = await qq.bot.panels.list('c2c')
    } catch (error) {
      log('qq panel list failed', error && error.message ? error.message : error)
    }
    const existing = records.find(
      (record) => record && record.panel && record.panel.remark === PANEL_REMARK && record.panel_id,
    )
    let id = existing ? existing.panel_id : ''
    if (!id) {
      id = await qq.bot.panels.create({
        scope: 'c2c',
        targetType: 'specific',
        userOpenids: targets,
        panel: { items, remark: PANEL_REMARK },
      })
    }
    qqPanelId = id
    qqPanelSignature = panelSignature(items)
    persistQQStateSoon()
    return id
  }

  // ---- QQ answer routing (approvals + questions) --------------------------
  //
  // DSH composes both decisions as Cordis waterfalls:
  //   approval/request       -> ApprovalOutcome  (allowed-once | rejected | cancelled | unavailable)
  //   user-questions/request -> { answers: [{ id, selected, custom? }] }
  // A listener that does not call next() becomes the answerer. We prepend and
  // park, so the phone is the only dialog for that turn — that is what makes a
  // reply from QQ actually reach the waiting tool call.
  //
  // Only used when both switches are on (channel + per session) AND the global
  // answer switches are on; otherwise the request falls through to the desktop
  // UI untouched.

  const pendingApprovals = new Map()
  const pendingQuestions = new Map()

  function isAllowedSender(openid) {
    if (!openid) return false
    const configured = String(cfg().qqOpenids ?? '')
      .split(/[\s,;，；]+/)
      .map((value) => value.trim())
      .filter(Boolean)
    if (configured.length > 0) return configured.includes(openid)
    return qqLearned.includes(openid)
  }

  function qqAnswerReady() {
    return Boolean(cfg().qqEnabled) && qqStatus.state === 'ready' && qqTargets().length > 0
  }

  /** Recover the gated command from the session log (the request itself omits it). */
  function commandOfCall(session, callId) {
    if (callId === undefined) return undefined
    try {
      const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (!event || event.type !== 'tool/call') continue
        if (String(event.data?.callId) !== String(callId)) continue
        const raw = event.data?.arguments
        if (typeof raw !== 'string') return undefined
        try {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && typeof parsed.command === 'string') {
            return parsed.command.length > 300 ? `${parsed.command.slice(0, 300)}…` : parsed.command
          }
        } catch {
          /* not JSON: fall through with the raw text */
        }
        return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
      }
    } catch {}
    return undefined
  }

  function approvalCardText(sessionId, title, request, command) {
    const lines = [cardHeader('🔒', sessionId, title, '需要权限审批')]
    if (request?.toolName) lines.push(`工具：${request.toolName}`)
    if (command) lines.push('命令：\n```\n' + command + '\n```')
    if (request?.reason) lines.push(`原因：${request.reason}`)
    lines.push('', '回复 **ok** 允许一次，**no** 拒绝')
    return lines.join('\n')
  }

  function questionCardText(sessionId, title, question, index, total) {
    const lines = [
      cardHeader('❓', sessionId, title, `需要你回答（${index}/${total}）`),
      `问题：${question.question}`,
    ]
    const options = Array.isArray(question.options) ? question.options : []
    if (options.length > 0) {
      lines.push('')
      options.forEach((option, i) => {
        lines.push(`${i + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`)
      })
      lines.push('', question.multiSelect ? '回复编号选择（多选用逗号），或直接输入文字' : '回复编号选择，或直接输入文字')
    } else {
      lines.push('', '直接输入你的回答')
    }
    return lines.join('\n')
  }

  /** Send one markdown card to every target; returns the ref_idx list, or undefined when nothing went out. */
  async function sendCardToTargets(markdown, sessionId) {
    if (!qq || qqStatus.state !== 'ready') return undefined
    const targets = qqTargets()
    if (targets.length === 0) return undefined
    const refIds = []
    let delivered = false
    for (const openid of targets) {
      try {
        const sent = await sendCard(openid, { markdown, sessionId })
        delivered = true
        if (sent && sent.refIdx) refIds.push(sent.refIdx)
      } catch (error) {
        console.warn('[notify-toast] QQ 卡片发送失败:', error && error.message ? error.message : error)
      }
    }
    return delivered ? refIds : undefined
  }

  async function parkApproval(request) {
    const session = request.agent.session
    const sessionId = session.id
    const alias = qqSubscriptions.get(sessionId)?.alias ?? 0
    const markdown = withBody(
      approvalCardText(sessionId, titleOf(session), request, commandOfCall(session, request.callId)),
      replyBodyPending(session),
      'Agent 到目前为止的说明',
    )
    const refIds = await sendCardToTargets(markdown, sessionId)
    if (!refIds) return undefined

    const entry = { sessionId, alias, request, refIds, resolve: () => {}, onAbort: undefined }
    const promise = new Promise((resolve) => {
      entry.resolve = resolve
    })
    if (request.signal) {
      const onAbort = () => {
        if (pendingApprovals.get(sessionId) !== entry) return
        pendingApprovals.delete(sessionId)
        resolve('cancelled')
      }
      entry.onAbort = onAbort
      request.signal.addEventListener('abort', onAbort, { once: true })
    }
    pendingApprovals.set(sessionId, entry)
    markSessionState(sessionId, 'approval')
    log(`qq approval parked: session=${sessionId}`)
    return promise
  }

  async function parkQuestion(request) {
    const session = request.agent.session
    const sessionId = session.id
    const questions = Array.isArray(request.questions) ? request.questions : []
    if (questions.length === 0) return undefined
    const title = titleOf(session)
    const alias = qqSubscriptions.get(sessionId)?.alias ?? 0
    const refIds = await sendCardToTargets(
      withBody(
        questionCardText(sessionId, title, questions[0], 1, questions.length),
        replyBodyPending(session),
        'Agent 到目前为止的说明',
      ),
      sessionId,
    )
    if (!refIds) return undefined

    const entry = {
      sessionId,
      alias,
      title,
      request,
      refIds,
      index: 0,
      collected: [],
      resolve: () => {},
      reject: () => {},
      onAbort: undefined,
    }
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    if (request.signal) {
      const onAbort = () => {
        if (pendingQuestions.get(sessionId) !== entry) return
        pendingQuestions.delete(sessionId)
        const error = new Error('ask_user_question was aborted before the user answered')
        error.code = 'ASK_ABORTED'
        reject(error)
      }
      entry.onAbort = onAbort
      request.signal.addEventListener('abort', onAbort, { once: true })
    }
    pendingQuestions.set(sessionId, entry)
    markSessionState(sessionId, 'question')
    log(`qq question parked: session=${sessionId} count=${questions.length}`)
    return promise
  }

  /** Passive reply anchored on the message we are answering. */
  async function replyQQ(openid, msgId, markdown) {
    if (!qq || !openid || !msgId) return
    try {
      await qq.bot.sendC2C(openid, { markdown, msgId })
      const entry = inboundAnchors.get(openid)
      if (entry && entry.msgId === msgId) entry.used += 1
    } catch (error) {
      log('qq ack failed', error && error.message ? error.message : error)
    }
  }

  /** Resolve one parked approval/question with the reply text. */
  async function answerPending(target, payload, message) {
    const openid = message.openid
    const msgId = message.msgId
    if (target.kind === 'approval') {
      const entry = target.entry
      const outcome = parseApprovalOutcome(payload)
      if (!outcome) {
        await replyQQ(openid, msgId, '没看懂：回复 **ok** 允许一次，或 **no** 拒绝')
        return
      }
      pendingApprovals.delete(entry.sessionId)
      if (entry.onAbort && entry.request.signal) {
        entry.request.signal.removeEventListener('abort', entry.onAbort)
      }
      entry.resolve(outcome)
      markSessionState(entry.sessionId, 'running')
      await replyQQ(
        openid,
        msgId,
        `${outcome === 'allowed-once' ? '✅ 已允许一次' : '🚫 已拒绝'}（会话 #${entry.alias}）`,
      )
      return
    }

    const entry = target.entry
    const question = entry.request.questions[entry.index]
    if (!question) {
      pendingQuestions.delete(entry.sessionId)
      return
    }
    entry.collected.push(parseQuestionAnswer(question, payload))
    entry.index += 1
    if (entry.index < entry.request.questions.length) {
      const next = entry.request.questions[entry.index]
      const refIds = await sendCardToTargets(
        questionCardText(entry.sessionId, entry.title, next, entry.index + 1, entry.request.questions.length),
        entry.sessionId,
      )
      if (refIds) entry.refIds.push(...refIds)
      await replyQQ(openid, msgId, `✅ 第 ${entry.index} 题已记录（会话 #${entry.alias}），下一题已发送`)
      return
    }
    pendingQuestions.delete(entry.sessionId)
    if (entry.onAbort && entry.request.signal) {
      entry.request.signal.removeEventListener('abort', entry.onAbort)
    }
    entry.resolve({ answers: entry.collected })
    markSessionState(entry.sessionId, 'running')
    await replyQQ(openid, msgId, `✅ 已提交全部回答（会话 #${entry.alias}）`)
  }

  /**
   * Route one inbound message to a parked decision.
   *
   * Resolution order: the quoted card (ref_idx) -> `#alias` prefix -> the only
   * pending decision. Session message routing (P4) slots in after this chain.
   *
   * @returns true when the message was consumed.
   */
  // ---- QQ -> DSH session routing (P4) -------------------------------------

  /** Sessions owned by the dsh-qqbot conversation bot: never a valid target. */
  let qqOwnedCache = { at: 0, ids: new Set() }
  function qqOwnedSessionIds() {
    if (Date.now() - qqOwnedCache.at < 10_000) return qqOwnedCache.ids
    const ids = new Set()
    try {
      const file = path.join(homedir(), '.dsh-qqbot', 'model-prefs.json')
      if (existsSync(file)) {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        for (const sessionId of Object.values(data?.sessionIds ?? {})) {
          if (typeof sessionId === 'string' && sessionId) ids.add(sessionId)
        }
      }
    } catch {}
    qqOwnedCache = { at: Date.now(), ids }
    return ids
  }

  /** Optional service access: the plugin does not inject `agents`, so never touch ctx.agents directly. */
  function agentsOf() {
    try {
      return ctx.get('agents')
    } catch {
      return undefined
    }
  }

  /**
   * Every session QQ knows about: exactly the subscriptions, live or not.
   *
   * A subscription survives restarts, an agent does not. So a subscribed
   * session can be missing from `agents.list()` — that is the `cold` state, and
   * it is still listed. Showing it is the whole point of subscribing: after a
   * restart the phone still says which sessions are wired up.
   *
   * Rows are sorted by alias so the numbering reads naturally; the panel
   * re-sorts by urgency later.
   */
  function qqVisibleSessions() {
    const live = liveAgents()
    const excluded = qqOwnedSessionIds()
    const rows = []
    for (const [sessionId, entry] of qqSubscriptions) {
      if (excluded.has(sessionId)) continue
      const agent = live.get(sessionId)
      let title = entry.title || ''
      if (agent && agent.session) {
        touchSubscription(sessionId)
        const fresh = safeTitle(agent.session)
        if (fresh && fresh !== entry.title) {
          entry.title = fresh
          persistQQStateSoon()
        }
        title = fresh || title
      }
      const running = Boolean(agent && agent.status === 'running')
      rows.push({
        sessionId,
        alias: entry.alias,
        since: entry.since,
        title: title || `会话 ${sessionId.slice(-8)}`,
        live: Boolean(agent),
        running,
        state: agent ? stateOfSession(sessionId, running) : 'cold',
      })
    }
    rows.sort((a, b) => a.alias - b.alias)
    return rows
  }

  function aliasToSessionMap() {
    const map = new Map()
    for (const [sessionId, entry] of qqSubscriptions) map.set(entry.alias, sessionId)
    return map
  }

  const HELP_TEXT = [
    '**QQ 通知机器人**',
    '/ls 列出可投递的会话',
    '/s 3 查看会话 #3 的状态',
    '#3 内容 发送到会话 #3',
    '/off 3 取消会话 #3 的 QQ 通知',
    '/status 通道状态',
    '指令面板里点任意一项，即可直接切到那个会话',
    '审批 / 提问：直接回 ok / no / 编号，或引用那张卡片回复',
  ].join('\n')

  async function handleList(message) {
    // Looking at the list is the natural moment to reconcile it with the store.
    pruneStaleSubscriptions()
    schedulePanelSync()
    const rows = qqVisibleSessions()
    if (rows.length === 0) {
      await replyQQ(
        message.openid,
        message.msgId,
        '当前没有开启 QQ 通知的会话。\n在 DSH 会话标题栏点 **QQ** 图标即可开启。',
      )
      return
    }
    // QQ swallows a leading `#`, so the alias is bolded instead of prefixed.
    const lines = ['**DSH 会话**']
    for (const row of rows) lines.push(`**#${row.alias}** ${stateBadge(row.state)} ${row.title}`)
    lines.push('', '发送 **#别名 + 内容** 投递；**/s 别名** 看状态')
    if (rows.some((row) => !row.live)) {
      lines.push('💤 未打开 = 会话当前没在 DSH 里运行，发消息会自动打开它')
    }
    await replyQQ(message.openid, message.msgId, lines.join('\n'))
  }

  /** `/s N` — what a 指令面板 entry inserts. Answers with that session's card. */
  async function handleShow(command, message) {
    if (!command.alias) {
      await replyQQ(message.openid, message.msgId, '用法：/s 3（查看会话 #3 的状态）')
      return
    }
    const sessionId = aliasToSessionMap().get(command.alias)
    if (!sessionId) {
      await replyQQ(
        message.openid,
        message.msgId,
        `没有 #${command.alias} 这个会话，发送 /ls 查看（编号在关闭通知后会释放，可能已被别的会话占用）`,
      )
      return
    }
    const row = qqVisibleSessions().find((item) => item.sessionId === sessionId)
    if (!row) {
      await replyQQ(message.openid, message.msgId, `#${command.alias} 不在 QQ 通知里，发送 /ls 查看`)
      return
    }
    const lines = [cardHeader('', sessionId, row.title, '')]
    lines.push(`状态：${stateBadge(row.state)}`)
    if (row.live) {
      const known = sessionStates.get(sessionId)
      if (known && known.at) lines.push(`更新：${fmtRelative(Date.now() - known.at)}前`)
    } else if (row.since) {
      lines.push(`开启于：${new Date(row.since).toLocaleString()}`)
    }
    lines.push(`QQ 通知：🔔 已开启（\`/off ${row.alias}\` 关闭）`)
    lines.push(
      '',
      row.live
        ? `发送 **#${row.alias} 内容** 可直接投递到该会话`
        : `发送 **#${row.alias} 内容** 投递，会自动在 DSH 中打开这个会话`,
    )
    await replyQQ(message.openid, message.msgId, lines.join('\n'))
  }

  async function handleStatus(message) {
    const rows = qqVisibleSessions()
    const liveCount = rows.filter((row) => row.live).length
    const aliases = rows.map((row) => `#${row.alias}`).join(' ')
    const lines = [
      '**QQ 通道**',
      `状态：${qqStatus.state}${qqStatus.state === 'ready' || !qqStatus.detail ? '' : ' · ' + qqStatus.detail}`,
      `订阅：${rows.length} 个会话（${liveCount} 个已打开）`,
      `待处理决策：${pendingApprovals.size + pendingQuestions.size}`,
      `指令面板：${cfg().qqPanelEnabled ? (qqPanelId ? '已同步' : '待创建') : '已关闭'}`,
      `别名：${aliases || '（无）'}`,
    ]
    await replyQQ(message.openid, message.msgId, lines.join('\n'))
  }

  async function handleOff(command, message) {
    if (!command.alias) {
      await replyQQ(message.openid, message.msgId, '用法：/off 3（取消会话 #3 的 QQ 通知）')
      return
    }
    const sessionId = aliasToSessionMap().get(command.alias)
    if (!sessionId) {
      await replyQQ(message.openid, message.msgId, `没有 #${command.alias} 这个会话，发送 /ls 查看`)
      return
    }
    subscribeQQ(sessionId, false)
    broadcast({ type: 'qq-subscription', sessionId, on: false, alias: command.alias })
    await replyQQ(
      message.openid,
      message.msgId,
      `已关闭 #${command.alias} 的 QQ 通知，编号已释放`,
    )
  }

  async function handleCommand(command, message) {
    if (command.command === 'ls') return handleList(message)
    if (command.command === 'status') return handleStatus(message)
    if (command.command === 's') return handleShow(command, message)
    if (command.command === 'off') return handleOff(command, message)
    return replyQQ(message.openid, message.msgId, HELP_TEXT)
  }

  /**
   * Deliver one QQ message into a DSH session.
   *
   * Uses the same `followup(createUserMessage(...))` entry the conversation
   * plugin uses, so the message lands in the session's inbox and the agent
   * picks it up at the next step boundary.
   *
   * A subscribed session can be cold (DSH restarted, nothing opened it). The
   * phone is exactly where the user expects it to keep working, so the alias
   * is enough to wake it: `agents.resume()` reloads the log into a live agent.
   */
  async function deliverToSession(sessionId, text, message) {
    const entry = qqSubscriptions.get(sessionId)
    const alias = entry ? entry.alias : 0
    const agents = agentsOf()
    let agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    let woke = false
    if (!agent) {
      if (!agents || typeof agents.resume !== 'function') {
        await replyQQ(message.openid, message.msgId, `无法打开会话 #${alias}：agents 服务不可用`)
        return
      }
      try {
        const handle = await agents.resume({ resumeSessionId: sessionId })
        agent = handle.agent
        woke = Boolean(agent)
      } catch (error) {
        await replyQQ(
          message.openid,
          message.msgId,
          `无法打开会话 #${alias}：${error && error.message ? error.message : error}`,
        )
        return
      }
      if (!agent) {
        await replyQQ(message.openid, message.msgId, `无法打开会话 #${alias}：恢复后仍没有 agent`)
        return
      }
    }
    try {
      const wasRunning = agent.status === 'running'
      const createUserMessage = await loadCreateUserMessage()
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      const note = woke ? '（已自动打开该会话）' : wasRunning ? '（会话忙，已排队）' : ''
      await replyQQ(message.openid, message.msgId, `✅ 已投递到 #${alias}${note}`)
    } catch (error) {
      await replyQQ(
        message.openid,
        message.msgId,
        `投递失败（#${alias}）：${error && error.message ? error.message : error}`,
      )
    }
  }

  /**
   * Route one inbound message.
   *
   * Order: slash command -> parked approval/question -> quoted notification
   * card -> `#alias` session message -> help. The decision branch is P2; the
   * session branch is P4.
   *
   * @returns true when the message was consumed.
   */
  async function routeInbound(message) {
    const openid = message.openid ?? message.memberOpenid
    if (!isAllowedSender(openid)) return false
    const text = String(message.content ?? '').trim()
    if (!text) return false

    const route = selectInboundRoute({
      approvals: pendingApprovals.values(),
      questions: pendingQuestions.values(),
      sentCards,
      aliasSessions: aliasToSessionMap(),
      refIdx: extractRefIdx(message.raw),
      text,
    })
    if (!route) return false

    if (route.kind === 'decision') {
      await answerPending(route.decision, route.decision.payload, message)
      return true
    }
    if (route.kind === 'command') {
      await handleCommand(route, message)
      return true
    }
    if (route.kind === 'session') {
      // A quoted card can outlive the subscription it came from.
      if (!qqSubscriptions.has(route.sessionId)) {
        await replyQQ(
          message.openid,
          message.msgId,
          '该会话的 QQ 通知已关闭，先到 DSH 会话标题栏点 QQ 图标重新开启。',
        )
        return true
      }
      await deliverToSession(route.sessionId, route.payload, message)
      return true
    }
    if (route.kind === 'error') {
      await replyQQ(message.openid, message.msgId, route.message)
      return true
    }
    return false
  }

  ctx.on('approval/request', async (req, next) => {
    try {
      const current = cfg()
      const sessionId = req && req.agent ? req.agent.id : undefined
      if (!current.qqEnabled || !current.qqAnswerApprovals) return next()
      if (!sessionId || !qqSubscriptions.has(sessionId)) return next()
      if (!qqAnswerReady()) return next()
      const parked = await parkApproval(req)
      return parked ?? next()
    } catch (error) {
      log('qq approval answerer failed', error)
      return next()
    }
  }, { global: true, prepend: true })

  ctx.on('user-questions/request', async (req, next) => {
    try {
      const current = cfg()
      const sessionId = req && req.agent ? req.agent.id : undefined
      if (!current.qqEnabled || !current.qqAnswerQuestions) return next()
      if (!sessionId || !qqSubscriptions.has(sessionId)) return next()
      if (!qqAnswerReady()) return next()
      const parked = await parkQuestion(req)
      return parked ?? next()
    } catch (error) {
      log('qq question answerer failed', error)
      return next()
    }
  }, { global: true, prepend: true })

  // ---- events -------------------------------------------------------------

  // A session that closes or gets archived leaves the board, but no turn event
  // will ever announce that — so listen to the lifecycle itself.
  //
  // `session/disposed` must NOT drop the subscription: it also fires when a
  // session merely leaves the in-memory store, i.e. every time it goes cold.
  // Deleting a session is detected from the session store on disk instead.
  try {
    ctx.on('session/disposed', (payload) => {
      forgetSession(sessionIdOf(payload))
    })
  } catch (error) {
    log('cannot listen to session/disposed', error)
  }

  // Archiving is an explicit user action, so the switch goes with it.
  try {
    ctx.on('workspace/session-archived', (payload) => {
      const sessionId = sessionIdOf(payload)
      if (!sessionId) return
      subscribeQQ(sessionId, false)
      forgetSession(sessionId)
    })
  } catch (error) {
    log('cannot listen to workspace/session-archived', error)
  }

  ctx.on('session/event', (session, event) => {
    const current = cfg()
    // `enabled` is the popup master switch; the QQ channel keeps working when
    // popups are off, as long as its own switch is on.
    if (!current.enabled && !current.qqEnabled) return
    if (!session || !event) return

    if (event.type === 'turn/start') {
      const pending = settleTimers.get(session.id)
      if (pending) { cancel(pending); settleTimers.delete(session.id) }
      markSessionState(session.id, 'running')
      touchSubscription(session.id)
      return
    }

    // The approval service always appends this audit event before asking any
    // answerer, so it fires even when the UI claims the approval/request
    // waterfall first and later listeners never run.
    if (event.type === 'approval/asked') {
      const data = event.data || {}
      const tool = data.toolName || '工具'
      const sessionId = session.id
      if (current.notifyOnApproval) {
        show({
          kind: 'approval',
          title: titleOf(session),
          subtitle: '需要权限审批 · ' + tool,
          sessionId,
        })
      }
      // When QQ owns the decision it sends its own card with the buttons, so a
      // second "go handle it in DSH" card would only mislead.
      const qqNotify = Boolean(
        current.qqEnabled && !current.qqAnswerApprovals && qqSubscriptions.has(sessionId),
      )
      if (qqNotify) {
        void notifyQQ({
          sessionId,
          emoji: '🔒',
          suffix: '需要权限审批',
          title: titleOf(session),
          cwd: session.header && session.header.cwd ? session.header.cwd : '',
          detail: `工具：${tool}\n（请回 DSH 处理；可在设置里开启「在 QQ 上回答审批」）`,
        })
      }
      return
    }

    if (event.type !== 'turn/end') return
    const reason = event.data && event.data.reason ? event.data.reason.kind : undefined
    const isDone = reason === 'completed'
    const isBad = reason === 'error' || reason === 'blocked' || reason === 'interrupted'
    const sessionId = session.id
    // Desktop cards and the QQ channel have independent switches: turning the
    // popup off must not silence the phone, and vice versa.
    const qqWanted = Boolean(
      current.qqEnabled
        && qqSubscriptions.has(sessionId)
        && (isDone ? current.qqNotifyOnComplete : current.qqNotifyOnError),
    )
    if (!isDone && !(current.notifyOnError && isBad) && !qqWanted) return
    if (session.header && (session.header.parentSession || session.header.origin === 'subagent')) return

    // The panel is a status board, so it must reflect the turn even when the
    // card itself is throttled away.
    markSessionState(
      sessionId,
      reason === 'completed'
        ? 'completed'
        : reason === 'error'
          ? 'error'
          : reason === 'blocked'
            ? 'blocked'
            : reason === 'interrupted'
              ? 'interrupted'
              : 'idle',
    )

    // Read the turn start from the log as it stands at this very event: process
    // memory is lost on a plugin reload, the durable log is not.
    const startedAt = turnStartTimeOf(session, event.seq)

    const existing = settleTimers.get(sessionId)
    if (existing) cancel(existing)

    const timer = later(() => {
      settleTimers.delete(sessionId)
      const now = Date.now()

      let subtitle = '任务已完成'
      if (reason === 'error') subtitle = '任务失败'
      else if (reason === 'blocked') subtitle = '已阻塞'
      else if (reason === 'interrupted') subtitle = '已中断'

      let elapsedText = ''
      if (reason === 'completed' && current.showElapsed && startedAt) {
        const seconds = (now - startedAt) / 1000
        if (seconds >= 5) {
          elapsedText = fmtDuration(seconds)
          subtitle += ' · 用时 ' + elapsedText
        }
      }

      const previous = lastFired.get(sessionId) || 0
      if (now - previous >= (Number(current.minIntervalMs) || 0)) {
        lastFired.set(sessionId, now)
        show({
          kind: reason === 'completed' ? 'complete' : 'error',
          title: titleOf(session),
          subtitle,
          sessionId,
        })
      }

      if (qqWanted) {
        const previousQQ = lastQQFired.get(sessionId) || 0
        if (now - previousQQ < (Number(current.qqMinIntervalMs) || 0)) return
        lastQQFired.set(sessionId, now)
        const error = reason === 'error' && event.data && event.data.reason ? event.data.reason.error : undefined
        const badge = reason === 'completed'
          ? { emoji: '✅', suffix: '会话完成' }
          : reason === 'blocked'
            ? { emoji: '⏸', suffix: '已阻塞' }
            : reason === 'interrupted'
              ? { emoji: '⏹', suffix: '已中断' }
              : { emoji: '⚠️', suffix: '任务失败' }
        const events = safeEvents(session)
        const turnSeconds = startedAt ? Math.max(0, (now - startedAt) / 1000) : 0
        const turnSummary = summarizeUsage(events, {
          fromSeq: startedAt ? turnStartSeq(events, event.seq) : 0,
          toSeq: event.seq,
        })
        // The stats line already carries this turn's duration; repeating it on
        // its own 用时 line would print the same number twice.
        const statsHasDuration = turnSummary.outputTokens > 0 && turnSeconds > 0
        void notifyQQ({
          sessionId,
          emoji: badge.emoji,
          suffix: badge.suffix,
          title: titleOf(session),
          cwd: session.header && session.header.cwd ? session.header.cwd : '',
          stats: statsLine(summarizeUsage(events), contextUsageOf(session), turnSummary, turnSeconds),
          elapsed: statsHasDuration ? '' : elapsedText,
          finishedAt: formatStamp(now),
          detail: error ? `错误：${error.code} ${error.message}` : '',
          body: cfg().qqNotifyReply ? turnTextSafe(events, event.seq) : '',
        })
      }
    }, Math.max(0, Number(current.settleMs) || 0))

    settleTimers.set(sessionId, timer)
  })

  /** First line of the pending question, for the card subtitle. */
  function questionPreview(args) {
    try {
      const questions = args && args.questions
      if (Array.isArray(questions) && questions.length > 0) {
        const text = questions[0] && questions[0].question
        if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 40)
      }
    } catch {}
    return ''
  }

  // The agent asking the user something blocks on an answer just like an
  // approval does, so it gets the same treatment: a card with a "?" icon.
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      const current = cfg()
      if (exec && exec.name === 'ask_user_question') {
        const session = exec.agent ? ctx.sessions.get(exec.agent.id) : undefined
        const preview = questionPreview(exec.arguments)
        if (current.enabled && current.notifyOnQuestion) {
          show({
            kind: 'question',
            title: session ? titleOf(session) : '新对话',
            subtitle: preview ? '需要你回答 · ' + preview : '需要你回答 · Agent 在等你',
            sessionId: exec.agent ? exec.agent.id : '',
          })
        }
        // When QQ owns the answer it sends the question itself; a parallel
        // "go answer in DSH" card would only be noise.
        const qqNotify = Boolean(
          current.qqEnabled
            && !current.qqAnswerQuestions
            && exec.agent
            && qqSubscriptions.has(exec.agent.id),
        )
        if (qqNotify) {
          void notifyQQ({
            sessionId: exec.agent.id,
            emoji: '❓',
            suffix: '需要你回答',
            title: session ? titleOf(session) : '新对话',
            detail: (preview ? `问题：${preview}\n` : '') + '（请回 DSH 回答；可在设置里开启「在 QQ 上回答提问」）',
          })
        }
      }
    } catch (error) {
      log('question notify failed', error)
    }
    return next()
  })

  // ---- sse bridge ---------------------------------------------------------

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/events',
    handler(req, res) {
      try {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write(': connected\n\n')
      } catch {
        return
      }
      sseClients.add(res)
      if (pendingFocus && Date.now() - pendingFocus.at < 30000) {
        try { res.write('data: ' + JSON.stringify({ type: 'focus', sessionId: pendingFocus.sessionId }) + '\n\n') } catch {}
        pendingFocus = null
      }
      const heartbeat = setInterval(() => {
        try { res.write(': hb\n\n') } catch {}
      }, 20000)
      const close = () => {
        clearInterval(heartbeat)
        sseClients.delete(res)
      }
      req.on('close', close)
      res.on('close', close)
      res.on('error', close)
    },
  }))

  // ---- QQ channel routes --------------------------------------------------

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/qq/state',
    handler(req, res) {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      const reply = (status, payload) => {
        try {
          res.writeHead(status, headers)
          res.end(JSON.stringify(payload))
        } catch {}
      }
      if (req.method !== 'GET') return reply(405, { ok: false, error: 'method not allowed' })
      let sessionId = ''
      try {
        sessionId = new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId') || ''
      } catch {}
      reply(200, {
        ok: true,
        global: qqGlobalState(),
        session: sessionId ? qqSessionState(sessionId) : null,
      })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/qq/subscribe',
    async handler(req, res) {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      const reply = (status, payload) => {
        try {
          res.writeHead(status, headers)
          res.end(JSON.stringify(payload))
        } catch {}
      }
      if (req.method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' })
      if (!cfg().qqEnabled) return reply(409, { ok: false, error: 'QQ 通知未启用' })
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (!sessionId) return reply(400, { ok: false, error: '缺少 sessionId' })
        subscribeQQ(sessionId, Boolean(body.enabled))
        const state = qqSessionState(sessionId)
        broadcast({ type: 'qq-subscription', ...state })
        reply(200, { ok: true, ...state })
      } catch (error) {
        reply(400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/qq/test',
    async handler(req, res) {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      const reply = (status, payload) => {
        try {
          res.writeHead(status, headers)
          res.end(JSON.stringify(payload))
        } catch {}
      }
      if (req.method !== 'POST') return reply(405, { ok: false, error: 'method not allowed' })
      if (!cfg().qqEnabled) return reply(409, { ok: false, error: 'QQ 通知未启用' })
      if (!qq || qqStatus.state !== 'ready') {
        return reply(409, {
          ok: false,
          error: `QQ 未连接（${qqStatus.state}${qqStatus.detail ? ': ' + qqStatus.detail : ''}）`,
        })
      }
      const targets = qqTargets()
      if (targets.length === 0) {
        return reply(409, { ok: false, error: '还没有接收者 openid：先给机器人发一条消息，或在配置里填写' })
      }
      try {
        const markdown = '🔔 **测试消息**\n来自 DSH 通知插件\n时间：' + new Date().toLocaleString()
        for (const openid of targets) await qq.bot.sendC2C(openid, { markdown })
        reply(200, { ok: true, targets: targets.length })
      } catch (error) {
        reply(502, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }))

  // Preview: render one card on demand so the settings page can show the
  // current look without waiting for a real turn or approval.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/preview',
    async handler(req, res) {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      const reply = (status, payload) => {
        try {
          res.writeHead(status, headers)
          res.end(JSON.stringify(payload))
        } catch {}
      }
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const requested = body && body.kind
        const kind = requested === 'approval' || requested === 'error' || requested === 'question' ? requested : 'complete'
        const cards = {
          complete: { title: '预览 · 桌面弹窗通知', subtitle: '任务已完成 · 这是预览卡片' },
          approval: { title: '预览 · 桌面弹窗通知', subtitle: '需要权限审批 · pwsh' },
          question: { title: '预览 · 桌面弹窗通知', subtitle: '需要你回答 · 这是预览卡片' },
          error: { title: '预览 · 桌面弹窗通知', subtitle: '任务失败 · 这是预览卡片' },
        }
        show({ kind, title: cards[kind].title, subtitle: cards[kind].subtitle, sessionId: '' })
        reply(200, { ok: true, kind })
      } catch (error) {
        reply(400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }))

  // Audition one sound without rendering a card.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/preview-sound',
    async handler(req, res) {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      const reply = (status, payload) => {
        try {
          res.writeHead(status, headers)
          res.end(JSON.stringify(payload))
        } catch {}
      }
      if (req.method !== 'POST') {
        reply(405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const sound = typeof body.sound === 'string' ? body.sound : 'none'
        const custom = typeof body.custom === 'string' ? body.custom : ''
        const wanted = custom || sound
        let resolved = null
        let exists = null
        if (wanted && wanted.toLowerCase().endsWith('.wav')) {
          try {
            resolved = path.isAbsolute(wanted) ? wanted : path.join(here, wanted)
            exists = existsSync(resolved)
          } catch {}
        }
        startChild()
          .then(() => send({ t: 'sound', sound, custom }))
          .catch((error) => {
            console.warn('[notify-toast] sound preview failed:', error && error.message ? error.message : error)
          })
        reply(200, { ok: true, resolved, exists })
      } catch (error) {
        reply(400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }))

  // ---- config bridge ------------------------------------------------------

  const NS = 'notify-toast'

  function describeSelf() {
    try {
      const settings = ctx.get('settings')
      if (!settings || typeof settings.describe !== 'function') return null
      return settings.describe().find((row) => row.ns === NS) || null
    } catch {
      return null
    }
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 256 * 1024) reject(new Error('body too large'))
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/config',
    async handler(req, res) {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      const send = (status, payload) => {
        try {
          res.writeHead(status, headers)
          res.end(JSON.stringify(payload))
        } catch {}
      }
      try {
        if (req.method === 'GET') {
          const descriptor = describeSelf()
          send(200, {
            ok: true,
            ns: NS,
            revision: descriptor ? descriptor.revision : 0,
            values: descriptor ? descriptor.value : cfg(),
            hasDescriptor: Boolean(descriptor),
          })
          return
        }
        if (req.method === 'POST') {
          const settings = ctx.get('settings')
          if (!settings || typeof settings.update !== 'function') {
            send(503, { ok: false, error: 'settings service unavailable' })
            return
          }
          const payload = JSON.parse((await readBody(req)) || '{}')
          const values = payload && typeof payload.values === 'object' && payload.values ? payload.values : {}
          await settings.update(NS, values, typeof payload.revision === 'number' ? payload.revision : undefined)
          const descriptor = describeSelf()
          send(200, { ok: true, revision: descriptor ? descriptor.revision : 0, values: descriptor ? descriptor.value : values })
          return
        }
        send(405, { ok: false, error: 'method not allowed' })
      } catch (error) {
        send(400, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }))

  /**
   * Fill in titles for subscriptions that predate the stored title field.
   *
   * Tries the sessions service first, which may expose a session without an
   * agent. If that call turns out to allocate an agent, it is switched off for
   * good — waking sessions just to read a label is not acceptable.
   */
  let sessionPeek = true
  function backfillTitles() {
    for (const [sessionId, entry] of qqSubscriptions) {
      if (entry.title) continue
      const title = peekTitle(sessionId)
      if (!title) continue
      entry.title = title
    }
    persistQQStateSoon()
  }

  function peekTitle(sessionId) {
    if (!sessionPeek) return ''
    try {
      const before = liveAgents().size
      const session = ctx.sessions.get(sessionId)
      if (liveAgents().size > before) {
        sessionPeek = false
        log('session peek allocates agents; disabled')
        return ''
      }
      return session ? safeTitle(session) : ''
    } catch {
      sessionPeek = false
      return ''
    }
  }

  // ---- QQ channel lifecycle -----------------------------------------------

  ctx.effect(() => {
    loadQQState()
    backfillTitles()
    pruneStaleSubscriptions()
    startQQBridge()
    return () => {
      stopQQBridge()
      if (qqStateTimer) {
        cancel(qqStateTimer)
        qqStateTimer = null
      }
      flushQQState()
    }
  })

  // Subscriptions that nobody touches for weeks are retired, not because the
  // session disappeared but because the switch was forgotten.
  ctx.effect(() => {
    const SWEEP_MS = 6 * 60 * 60 * 1000
    let timer = null
    const tick = () => {
      try {
        pruneStaleSubscriptions()
      } catch (error) {
        log('subscription sweep failed', error)
      }
      timer = later(tick, SWEEP_MS)
    }
    timer = later(tick, SWEEP_MS)
    return () => { if (timer) cancel(timer) }
  })

  // ---- lifecycle ----------------------------------------------------------

  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    settleTimers.clear()
    for (const response of sseClients) {
      try { response.end() } catch {}
    }
    sseClients.clear()
    return shutdownChild()
  })

  log('plugin loaded, schemastery=' + (z ? 'yes' : 'no'))
}
