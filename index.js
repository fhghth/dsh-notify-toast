/**
 * Host half: watches session/approval events, drives the standalone notifier
 * process over NDJSON, and relays "user clicked a card" to the page over SSE.
 */
import path from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
}

const BOOL_KEYS = [
  'enabled', 'notifyOnComplete', 'notifyOnApproval', 'notifyOnQuestion', 'notifyOnError',
  'soundEnabled', 'showElapsed', 'clickToOpenSession', 'debug',
]
const NUM_KEYS = [
  'width', 'height', 'scale', 'margin', 'gap', 'maxCards', 'durationMs',
  'settleMs', 'minIntervalMs', 'idleExitMs',
]

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

  // ---- events -------------------------------------------------------------

  ctx.on('session/event', (session, event) => {
    const current = cfg()
    if (!current.enabled) return
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
      if (!current.notifyOnApproval) return
      const data = event.data || {}
      const tool = data.toolName || '工具'
      show({
        kind: 'approval',
        title: titleOf(session),
        subtitle: '需要权限审批 · ' + tool,
        sessionId: session.id,
      })
      return
    }

    if (event.type !== 'turn/end') return
    const reason = event.data && event.data.reason ? event.data.reason.kind : undefined
    const isDone = reason === 'completed'
    const isBad = reason === 'error' || reason === 'blocked' || reason === 'interrupted'
    if (!isDone && !(current.notifyOnError && isBad)) return
    if (session.header && (session.header.parentSession || session.header.origin === 'subagent')) return

    // Read the turn start from the log as it stands at this very event: process
    // memory is lost on a plugin reload, the durable log is not.
    const startedAt = turnStartTimeOf(session, event.seq)

    const sessionId = session.id
    const existing = settleTimers.get(sessionId)
    if (existing) cancel(existing)

    const timer = later(() => {
      settleTimers.delete(sessionId)
      const now = Date.now()
      const previous = lastFired.get(sessionId) || 0
      if (now - previous < (Number(current.minIntervalMs) || 0)) return
      lastFired.set(sessionId, now)

      let subtitle = '任务已完成'
      if (reason === 'error') subtitle = '任务失败'
      else if (reason === 'blocked') subtitle = '已阻塞'
      else if (reason === 'interrupted') subtitle = '已中断'

      if (reason === 'completed' && current.showElapsed && startedAt) {
        const seconds = (Date.now() - startedAt) / 1000
        if (seconds >= 5) subtitle += ' · 用时 ' + fmtDuration(seconds)
      }

      show({
        kind: reason === 'completed' ? 'complete' : 'error',
        title: titleOf(session),
        subtitle,
        sessionId,
      })
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
      if (current.enabled && current.notifyOnQuestion && exec && exec.name === 'ask_user_question') {
        const session = exec.agent ? ctx.sessions.get(exec.agent.id) : undefined
        const preview = questionPreview(exec.arguments)
        show({
          kind: 'question',
          title: session ? titleOf(session) : '新对话',
          subtitle: preview ? '需要你回答 · ' + preview : '需要你回答 · Agent 在等你',
          sessionId: exec.agent ? exec.agent.id : '',
        })
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
