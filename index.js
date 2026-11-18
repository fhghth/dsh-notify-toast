/**
 * Host half: watches session/approval events, drives the standalone notifier
 * process over NDJSON, and relays "user clicked a card" to the page over SSE.
 */
import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createQQBotLite } from './qqbot-lite/index.js'
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
}

const BOOL_KEYS = [
  'enabled', 'notifyOnComplete', 'notifyOnApproval', 'notifyOnQuestion', 'notifyOnError',
  'soundEnabled', 'showElapsed', 'clickToOpenSession', 'debug',
  'qqEnabled', 'qqNotifyOnComplete', 'qqNotifyOnError',
  'qqAnswerApprovals', 'qqAnswerQuestions', 'qqAutoResume',
]
const NUM_KEYS = [
  'width', 'height', 'scale', 'margin', 'gap', 'maxCards', 'durationMs',
  'settleMs', 'minIntervalMs', 'idleExitMs', 'qqMinIntervalMs',
]

/** QQ channel runtime files live outside the bundle, next to the user's home. */
const QQ_DATA_DIR = path.join(homedir(), '.dsh-notify-toast')
const QQ_STATE_FILE = path.join(QQ_DATA_DIR, 'state.json')
const QQ_LOCK_FILE = path.join(QQ_DATA_DIR, 'qqbot.lock')

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
  /** sessionId -> { alias, since } — presence means "this session forwards". */
  const qqSubscriptions = new Map()
  const lastQQFired = new Map()
  let qqAliasSeq = 0
  /** sessionId -> alias. Independent from subscriptions: an alias makes a session addressable, the switch makes it notify. */
  const qqAliases = new Map()
  /** ref_idx of a notification card -> the session it describes (for quoted-reply routing). */
  const sentCards = new Map()
  /** openids learned from inbound messages (fallback when config is empty). */
  let qqLearned = []
  let qqStateTimer = null
  let qqLockHeld = false

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
    qqAliases.clear()
    qqAliasSeq = 0
    qqLearned = []
    try {
      if (!existsSync(QQ_STATE_FILE)) return
      const data = JSON.parse(readFileSync(QQ_STATE_FILE, 'utf8'))
      const subscriptions = data && typeof data.subscriptions === 'object' ? data.subscriptions : {}
      for (const [sessionId, value] of Object.entries(subscriptions)) {
        if (!sessionId || !value || value.on === false) continue
        qqSubscriptions.set(sessionId, {
          alias: Number(value.alias) > 0 ? Number(value.alias) : 0,
          since: Number(value.since) > 0 ? Number(value.since) : 0,
        })
      }
      qqAliasSeq = Number(data?.aliasSeq) > 0 ? Number(data.aliasSeq) : 0
      const aliases = data && typeof data.aliases === 'object' ? data.aliases : {}
      for (const [sessionId, alias] of Object.entries(aliases)) {
        const value = Number(alias)
        if (!sessionId || !Number.isInteger(value) || value <= 0) continue
        qqAliases.set(sessionId, value)
        qqAliasSeq = Math.max(qqAliasSeq, value)
      }
      // Sessions subscribed before aliases were split out keep their number.
      for (const [sessionId, entry] of qqSubscriptions) {
        if (qqAliases.has(sessionId) || entry.alias <= 0) continue
        qqAliases.set(sessionId, entry.alias)
        qqAliasSeq = Math.max(qqAliasSeq, entry.alias)
      }
      qqLearned = Array.isArray(data?.learnedOpenids)
        ? data.learnedOpenids.filter((value) => typeof value === 'string' && value)
        : []
    } catch (error) {
      log('qq state load failed', error)
    }
  }

  function flushQQState() {
    try {
      mkdirSync(QQ_DATA_DIR, { recursive: true })
      const subscriptions = {}
      for (const [sessionId, value] of qqSubscriptions) {
        subscriptions[sessionId] = { on: true, alias: value.alias, since: value.since }
      }
      const payload = {
        version: 2,
        aliasSeq: qqAliasSeq,
        subscriptions,
        aliases: Object.fromEntries(qqAliases),
        learnedOpenids: qqLearned,
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

  /** Assign a stable routing alias (never reused) to one session. */
  function ensureAlias(sessionId) {
    const existing = qqAliases.get(sessionId)
    if (existing) return existing
    qqAliasSeq += 1
    qqAliases.set(sessionId, qqAliasSeq)
    persistQQStateSoon()
    return qqAliasSeq
  }

  function subscribeQQ(sessionId, enabled) {
    if (enabled) {
      const alias = ensureAlias(sessionId)
      if (qqSubscriptions.has(sessionId)) return alias
      qqSubscriptions.set(sessionId, { alias, since: Date.now() })
      persistQQStateSoon()
      return alias
    }
    if (qqSubscriptions.delete(sessionId)) persistQQStateSoon()
    return qqAliases.get(sessionId) ?? 0
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
    return { sessionId, on: Boolean(entry), alias: qqAliases.get(sessionId) ?? 0 }
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
      if (state.state === 'fatal') {
        console.error('[notify-toast] QQ 网关致命错误:', state.detail)
      }
    })

    // Inbound routing: a reply that answers a parked approval/question is
    // consumed here; anything else gets the connection guide.
    bot.on('message', async (message) => {
      const openid = message.openid ?? message.memberOpenid
      if (openid && !qqLearned.includes(openid)) {
        qqLearned.push(openid)
        persistQQStateSoon()
        broadcast({ type: 'qq-status', ...qqGlobalState() })
      }
      if (!openid || !message.msgId) return
      if (await routeInbound(message)) return
      try {
        await bot.sendC2C(openid, {
          markdown: [
            '**通知机器人已连接**',
            '在 DSH 会话标题栏点 **QQ** 图标，即可让该会话把通知转发到这里。',
            '（当前版本只支持通知与审批/提问回复，暂不支持发消息给会话）',
          ].join('\n'),
          msgId: message.msgId,
        })
      } catch (error) {
        log('qq reply failed', error && error.message ? error.message : error)
      }
    })

    qq = { bot, stop: () => bot.stop() }
    setQQStatus('connecting', '')
    bot.start().catch((error) => {
      const message = error && error.message ? error.message : String(error)
      setQQStatus('error', message)
      console.error('[notify-toast] QQ 网关启动失败:', message)
    })
  }

  /** Send one programmatic card to every target. */
  async function notifyQQ({ sessionId, headline, title, cwd, elapsed, detail }) {
    if (!qq || qqStatus.state !== 'ready') return
    const targets = qqTargets()
    if (targets.length === 0) {
      log('qq notify skipped: no target openid')
      return
    }
    const lines = [headline, `标题：${title}`]
    if (elapsed) lines.push(`用时：${elapsed}`)
    if (cwd) lines.push(`目录：${cwd}`)
    if (detail) lines.push(detail)
    const markdown = lines.join('\n')
    for (const openid of targets) {
      try {
        const sent = await qq.bot.sendC2C(openid, { markdown })
        // Quoting this card later routes the reply back to the same session.
        if (sent && sent.refIdx) rememberSentCard(sent.refIdx, sessionId)
      } catch (error) {
        console.warn('[notify-toast] QQ 通知发送失败:', error && error.message ? error.message : error)
      }
    }
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

  function approvalCardText(title, request, command) {
    const lines = ['🔒 **需要权限审批**', `标题：${title}`]
    if (request?.toolName) lines.push(`工具：${request.toolName}`)
    if (command) lines.push('命令：\n```\n' + command + '\n```')
    if (request?.reason) lines.push(`原因：${request.reason}`)
    lines.push('', '回复 **ok** 允许一次，**no** 拒绝')
    return lines.join('\n')
  }

  function questionCardText(title, question, index, total) {
    const lines = [`❓ **需要你回答**（${index}/${total}）`, `标题：${title}`, `问题：${question.question}`]
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
  async function sendCardToTargets(markdown) {
    if (!qq || qqStatus.state !== 'ready') return undefined
    const targets = qqTargets()
    if (targets.length === 0) return undefined
    const refIds = []
    let delivered = false
    for (const openid of targets) {
      try {
        const sent = await qq.bot.sendC2C(openid, { markdown })
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
    const markdown = approvalCardText(titleOf(session), request, commandOfCall(session, request.callId))
    const refIds = await sendCardToTargets(markdown)
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
    const refIds = await sendCardToTargets(questionCardText(title, questions[0], 1, questions.length))
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
    log(`qq question parked: session=${sessionId} count=${questions.length}`)
    return promise
  }

  async function replyQQ(openid, msgId, markdown) {
    if (!qq || !openid || !msgId) return
    try {
      await qq.bot.sendC2C(openid, { markdown, msgId })
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
      const refIds = await sendCardToTargets(questionCardText(entry.title, next, entry.index + 1, entry.request.questions.length))
      if (refIds) entry.refIds.push(...refIds)
      await replyQQ(openid, msgId, `✅ 第 ${entry.index} 题已记录（会话 #${entry.alias}），下一题已发送`)
      return
    }
    pendingQuestions.delete(entry.sessionId)
    if (entry.onAbort && entry.request.signal) {
      entry.request.signal.removeEventListener('abort', entry.onAbort)
    }
    entry.resolve({ answers: entry.collected })
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

  /** Live, addressable sessions with their titles and stable aliases. */
  function listRoutableSessions() {
    const agents = ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
    const excluded = qqOwnedSessionIds()
    const rows = []
    for (const agent of agents) {
      const session = agent && agent.session
      if (!session || !session.id) continue
      if (session.header && session.header.origin === 'subagent') continue
      if (excluded.has(session.id)) continue
      rows.push({
        sessionId: session.id,
        alias: ensureAlias(session.id),
        title: titleOf(session),
        running: agent.status === 'running',
        subscribed: qqSubscriptions.has(session.id),
      })
    }
    rows.sort((a, b) => a.alias - b.alias)
    return rows
  }

  function aliasToSessionMap() {
    const map = new Map()
    for (const [sessionId, alias] of qqAliases) map.set(alias, sessionId)
    return map
  }

  const HELP_TEXT = [
    '**QQ 通知机器人**',
    '/ls 列出可投递的会话',
    '#3 内容 发送到会话 #3',
    '/off 3 取消会话 #3 的 QQ 通知',
    '/status 通道状态',
    '审批 / 提问：直接回 ok / no / 编号，或引用那张卡片回复',
  ].join('\n')

  async function handleList(message) {
    const rows = listRoutableSessions()
    if (rows.length === 0) {
      await replyQQ(message.openid, message.msgId, '当前没有可投递的会话（它们可能都没打开）。')
      return
    }
    const lines = ['**DSH 会话**']
    for (const row of rows) {
      lines.push(`#${row.alias} ${row.running ? '▶' : '·'} ${row.title}${row.subscribed ? ' 🔔' : ''}`)
    }
    lines.push('', '发送 **#别名 + 内容** 投递到该会话')
    await replyQQ(message.openid, message.msgId, lines.join('\n'))
  }

  async function handleStatus(message) {
    const aliases = [...qqAliases.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([, alias]) => `#${alias}`)
      .join(' ')
    const lines = [
      '**QQ 通道**',
      `状态：${qqStatus.state}${qqStatus.detail ? ' · ' + qqStatus.detail : ''}`,
      `订阅：${qqSubscriptions.size} 个会话`,
      `待处理决策：${pendingApprovals.size + pendingQuestions.size}`,
      `别名：${aliases || '（无，发送 /ls 分配）'}`,
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
    await replyQQ(message.openid, message.msgId, `已取消 #${command.alias} 的 QQ 通知（别名仍可用于投递）`)
  }

  async function handleCommand(command, message) {
    if (command.command === 'ls') return handleList(message)
    if (command.command === 'status') return handleStatus(message)
    if (command.command === 'off') return handleOff(command, message)
    return replyQQ(message.openid, message.msgId, HELP_TEXT)
  }

  /**
   * Deliver one QQ message into a DSH session.
   *
   * Uses the same `followup(createUserMessage(...))` entry the conversation
   * plugin uses, so the message lands in the session's inbox and the agent
   * picks it up at the next step boundary. Cold sessions are refused unless
   * `qqAutoResume` is on (resuming wakes an agent the user may not expect).
   */
  async function deliverToSession(sessionId, text, message) {
    const alias = qqAliases.get(sessionId) ?? 0
    let agent = ctx.agents.get(sessionId)
    if (!agent) {
      if (!cfg().qqAutoResume) {
        await replyQQ(
          message.openid,
          message.msgId,
          `会话 #${alias} 当前没有打开（没有活动 agent）。请先在 DSH 打开它，或在设置里开启「自动唤醒冷会话」。`,
        )
        return
      }
      try {
        const handle = await ctx.agents.resume({ resumeSessionId: sessionId })
        agent = handle.agent
      } catch (error) {
        await replyQQ(
          message.openid,
          message.msgId,
          `无法唤醒会话 #${alias}：${error && error.message ? error.message : error}`,
        )
        return
      }
    }
    try {
      const createUserMessage = await loadCreateUserMessage()
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await replyQQ(
        message.openid,
        message.msgId,
        `✅ 已投递到 #${alias}${agent.status === 'running' ? '（会话忙，已排队）' : ''}`,
      )
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

  ctx.on('session/event', (session, event) => {
    const current = cfg()
    // `enabled` is the popup master switch; the QQ channel keeps working when
    // popups are off, as long as its own switch is on.
    if (!current.enabled && !current.qqEnabled) return
    if (!session || !event) return

    if (event.type === 'turn/start') {
      const pending = settleTimers.get(session.id)
      if (pending) { cancel(pending); settleTimers.delete(session.id) }
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
          headline: '🔒 **需要权限审批**',
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
        void notifyQQ({
          sessionId,
          headline: reason === 'completed'
            ? '✅ **会话完成**'
            : reason === 'blocked'
              ? '⏸ **已阻塞**'
              : reason === 'interrupted'
                ? '⏹ **已中断**'
                : '⚠️ **任务失败**',
          title: titleOf(session),
          cwd: session.header && session.header.cwd ? session.header.cwd : '',
          elapsed: elapsedText,
          detail: error ? `错误：${error.code} ${error.message}` : '',
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
            headline: '❓ **需要你回答**',
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

  // ---- QQ channel lifecycle -----------------------------------------------

  ctx.effect(() => {
    loadQQState()
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
