/**
 * QQ Bot gateway client (WebSocket, zero dependencies).
 *
 * Official contract (api-v2 / WebSocket 方式 + 通用数据结构):
 *   1. GET  {baseUrl}/gateway           -> { url: "wss://api.bot.qq.com/websocket/" }
 *   2. open the socket; the first frame is op 10 Hello { heartbeat_interval }
 *   3. send op 2 Identify { token, intents, shard:[0,1], properties }
 *      (or op 6 Resume { token, session_id, seq } when a session survives)
 *   4. heartbeat with op 1 and the latest received `s`
 *   5. op 0 Dispatch carries { id, t, d, s }; `id` is the event id used as a
 *      passive-reply anchor, `d.id` is the message id for C2C/group messages.
 *
 * Close codes with a defined retry policy (same table as the official docs):
 *   4009            -> resume
 *   4006 / 4007     -> drop the session, identify again
 *   4001/4002/4010/4011/4012/4013/4014/4914/4915 -> fatal, do not reconnect
 *   4008, 4900-4913, everything else -> reconnect with identify
 */

const DEFAULT_BASE_URL = 'https://api.bot.qq.com'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_HEARTBEAT_FALLBACK_MS = 45_000
const DEFAULT_RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
const IDENTIFY_TIMEOUT_MS = 15_000

export const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
}

/** Intent bits used by this module (subset of the official table). */
export const Intents = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  /** What a C2C/group notification bot actually needs. */
  DEFAULT: (1 << 25) | (1 << 26),
}

const FATAL_CLOSE_CODES = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915])

export class GatewayError extends Error {
  constructor(message, { code, fatal = false } = {}) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
    this.fatal = fatal
  }
}

/** @param {number} code */
export function planCloseRecovery(code) {
  if (FATAL_CLOSE_CODES.has(code)) return 'fatal'
  if (code === 4009) return 'resume'
  if (code === 4006 || code === 4007) return 'identify-reset'
  return 'identify'
}

/**
 * @param {object} options
 * @param {{ getToken: (opts?: { force?: boolean }) => Promise<string> }} options.tokenSource
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {typeof WebSocket} [options.WebSocketImpl]
 * @param {number} [options.intents]
 * @param {object} [options.logger]
 * @param {(event: { t: string, d: any, id?: string, s?: number }) => void} [options.onEvent]
 * @param {(state: { state: string, detail?: string }) => void} [options.onState]
 * @param {number[]} [options.reconnectDelays]
 * @param {number} [options.maxAttempts]
 * @param {number} [options.timeoutMs]
 */
export function createGateway(options) {
  const {
    tokenSource,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    intents = Intents.DEFAULT,
    logger = {},
    onEvent = () => {},
    onState = () => {},
    reconnectDelays = DEFAULT_RECONNECT_DELAYS,
    maxAttempts = Number.POSITIVE_INFINITY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options ?? {}

  if (!tokenSource) throw new GatewayError('createGateway requires a tokenSource')
  if (typeof WebSocketImpl !== 'function') {
    throw new GatewayError('global WebSocket is unavailable (Node.js 22+ required)')
  }

  let socket = null
  let heartbeatTimer = null
  let reconnectTimer = null
  let identifyTimer = null
  let stopped = false
  let attempt = 0
  let sessionId
  let lastSeq
  let ready = false
  let starting = false

  function log(level, message) {
    const fn = logger[level]
    if (typeof fn === 'function') fn(`[qqbot-gateway] ${message}`)
  }

  function setState(state, detail) {
    try {
      onState({ state, detail })
    } catch (error) {
      log('error', `onState threw: ${errorText(error)}`)
    }
  }

  function clearHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function clearIdentifyTimer() {
    if (identifyTimer !== null) {
      clearTimeout(identifyTimer)
      identifyTimer = null
    }
  }

  function clearReconnect() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  async function fetchGatewayUrl() {
    const token = await tokenSource.getToken()
    let response
    try {
      response = await fetchImpl(`${baseUrl}/gateway`, {
        headers: { authorization: `QQBot ${token}`, 'user-agent': 'dsh-qqbot-lite/0.1' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new GatewayError(`获取网关地址失败：${errorText(error)}`)
    }
    const text = await response.text()
    let body
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      throw new GatewayError(`网关地址返回非 JSON (HTTP ${response.status})`, { code: response.status })
    }
    if (response.status === 401) {
      tokenSource.invalidate()
      throw new GatewayError('获取网关地址被拒绝 (401)：token 失效', { code: 401 })
    }
    if (body && typeof body.code === 'number' && body.code !== 0) {
      throw new GatewayError(`获取网关地址被拒绝：code=${body.code}`, { code: body.code })
    }
    if (!body || typeof body.url !== 'string' || !body.url) {
      throw new GatewayError(`网关地址响应缺少 url (HTTP ${response.status})`, { code: response.status })
    }
    return body.url
  }

  function sendPayload(payload) {
    if (!socket || socket.readyState !== 1 /* OPEN */) return false
    try {
      socket.send(JSON.stringify(payload))
      return true
    } catch (error) {
      log('error', `send failed: ${errorText(error)}`)
      return false
    }
  }

  function startHeartbeat(intervalMs) {
    clearHeartbeat()
    const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_HEARTBEAT_FALLBACK_MS
    heartbeatTimer = setInterval(() => {
      sendPayload({ op: GatewayOp.HEARTBEAT, d: lastSeq ?? null })
    }, period)
    // Do not keep the process alive just for the heartbeat.
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
  }

  async function authenticate() {
    const token = await tokenSource.getToken()
    if (stopped) return
    clearIdentifyTimer()
    identifyTimer = setTimeout(() => {
      log('warn', 'identify/resume timeout, reconnecting')
      closeSocket()
      scheduleReconnect('identify-timeout')
    }, IDENTIFY_TIMEOUT_MS)
    if (typeof identifyTimer.unref === 'function') identifyTimer.unref()

    if (sessionId && lastSeq !== undefined && lastSeq !== null) {
      log('info', `resume session=${sessionId} seq=${lastSeq}`)
      sendPayload({
        op: GatewayOp.RESUME,
        d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq },
      })
      return
    }
    log('info', `identify intents=${intents}`)
    sendPayload({
      op: GatewayOp.IDENTIFY,
      d: {
        token: `QQBot ${token}`,
        intents,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: 'dsh-qqbot-lite', $device: 'dsh' },
      },
    })
  }

  function handlePayload(raw) {
    let payload
    try {
      payload = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(decode(raw))
    } catch (error) {
      log('warn', `unparseable frame: ${errorText(error)}`)
      return
    }
    if (!payload || typeof payload !== 'object') return

    if (typeof payload.s === 'number') lastSeq = payload.s

    switch (payload.op) {
      case GatewayOp.HELLO: {
        const interval = payload.d?.heartbeat_interval
        startHeartbeat(interval)
        void authenticate().catch((error) => {
          log('error', `auth failed: ${errorText(error)}`)
          closeSocket()
          scheduleReconnect('auth-failed')
        })
        return
      }
      case GatewayOp.HEARTBEAT_ACK:
        return
      case GatewayOp.HEARTBEAT:
        sendPayload({ op: GatewayOp.HEARTBEAT, d: lastSeq ?? null })
        return
      case GatewayOp.RECONNECT:
        log('info', 'gateway requested reconnect')
        closeSocket()
        scheduleReconnect('server-reconnect')
        return
      case GatewayOp.INVALID_SESSION:
        log('warn', 'invalid session, dropping resume state')
        sessionId = undefined
        lastSeq = undefined
        closeSocket()
        scheduleReconnect('invalid-session')
        return
      case GatewayOp.DISPATCH:
        handleDispatch(payload)
        return
      default:
        log('debug', `unhandled op=${payload.op}`)
    }
  }

  function handleDispatch(payload) {
    const t = payload.t
    if (t === 'READY') {
      sessionId = payload.d?.session_id
      ready = true
      attempt = 0
      clearIdentifyTimer()
      setState('ready', sessionId)
      log('info', `ready session=${sessionId}`)
      return
    }
    if (t === 'RESUMED') {
      ready = true
      attempt = 0
      clearIdentifyTimer()
      setState('ready', sessionId)
      log('info', 'resumed')
      return
    }
    if (!ready) {
      // Any dispatch before READY is unexpected but harmless; still surface it.
      log('warn', `dispatch before ready: t=${t}`)
    }
    try {
      onEvent({ t, d: payload.d, id: payload.id, s: payload.s })
    } catch (error) {
      log('error', `onEvent threw: ${errorText(error)}`)
    }
  }

  function closeSocket() {
    const current = socket
    socket = null
    ready = false
    clearHeartbeat()
    if (!current) return
    try {
      current.close(1000, 'client close')
    } catch {
      /* already closed */
    }
  }

  function scheduleReconnect(reason) {
    if (stopped) return
    if (attempt >= maxAttempts) {
      setState('fatal', `reconnect budget exhausted (${reason})`)
      log('error', `reconnect budget exhausted: ${reason}`)
      return
    }
    const delay = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)]
    attempt += 1
    setState('reconnecting', `${reason} in ${delay}ms`)
    log('info', `reconnect #${attempt} in ${delay}ms (${reason})`)
    clearReconnect()
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect().catch((error) => {
        log('error', `reconnect failed: ${errorText(error)}`)
        scheduleReconnect('connect-failed')
      })
    }, delay)
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref()
  }

  function handleClose(code) {
    ready = false
    clearHeartbeat()
    clearIdentifyTimer()
    const action = planCloseRecovery(code)
    if (action === 'fatal') {
      stopped = true
      setState('fatal', `gateway closed with fatal code ${code}`)
      log('error', `fatal close ${code}`)
      return
    }
    if (action === 'resume') {
      log('info', `close ${code}: resuming`)
      scheduleReconnect(`close-${code}-resume`)
      return
    }
    if (action === 'identify-reset') {
      sessionId = undefined
      lastSeq = undefined
      log('info', `close ${code}: dropping session and identifying again`)
      scheduleReconnect(`close-${code}-identify`)
      return
    }
    log('info', `close ${code}: reconnecting with identify`)
    scheduleReconnect(`close-${code}`)
  }

  async function connect() {
    if (stopped) return
    setState('connecting')
    const url = await fetchGatewayUrl()
    if (stopped) return
    const ws = new WebSocketImpl(url)
    socket = ws

    ws.addEventListener('open', () => {
      if (socket !== ws) return
      log('info', 'socket open, waiting for hello')
    })

    ws.addEventListener('message', (event) => {
      if (socket !== ws) return
      handlePayload(event.data)
    })

    ws.addEventListener('close', (event) => {
      if (socket !== ws) {
        // A superseded socket must not drive reconnect logic.
        return
      }
      const code = typeof event.code === 'number' ? event.code : 1006
      log('info', `socket closed code=${code}`)
      socket = null
      handleClose(code)
    })

    ws.addEventListener('error', (event) => {
      if (socket !== ws) return
      log('error', `socket error: ${event?.message ?? 'unknown'}`)
    })
  }

  async function start() {
    if (starting) return
    starting = true
    stopped = false
    attempt = 0
    try {
      await connect()
    } finally {
      starting = false
    }
  }

  function stop() {
    stopped = true
    ready = false
    clearReconnect()
    closeSocket()
    setState('closed')
  }

  return {
    start,
    stop,
    get ready() {
      return ready
    },
    get sessionId() {
      return sessionId
    },
    get lastSeq() {
      return lastSeq
    },
  }
}

function decode(data) {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  }
  return String(data)
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
