/**
 * qqbot-lite — a zero-dependency QQ Bot client for a notification bot.
 *
 * Composition of three protocol pieces:
 *   token.js   -> POST /app/getAppAccessToken (cached, refresh 60s early)
 *   api.js     -> POST /v2/users/{openid}/messages (passive / recall / proactive)
 *   gateway.js -> GET /gateway + WebSocket (hello/identify/heartbeat/resume)
 *
 * Deliberately NOT included (the official SDK covers these, we do not need them):
 * middleware chain, mention gating, media upload, streaming, webhook transport,
 * session persistence, command routing.
 *
 * Events emitted:
 *   'ready'      { sessionId }
 *   'state'      { state, detail }
 *   'message'    normalized C2C / group message
 *   'control'    other dispatches worth seeing (FRIEND_ADD, C2C_MSG_REJECT, ...)
 *   'error'      Error
 */

import { createTokenSource } from './token.js'
import { createApi, QQBotApiError, MsgType } from './api.js'
import { createGateway, GatewayError, GatewayOp, Intents, planCloseRecovery } from './gateway.js'

export { createTokenSource, createApi, createGateway, Intents, MsgType, GatewayOp, planCloseRecovery, QQBotApiError, GatewayError }
export { TokenError } from './token.js'

/** Dispatches that are interesting to a notification bot but are not messages. */
const CONTROL_EVENTS = new Set([
  'FRIEND_ADD',
  'FRIEND_DEL',
  'C2C_MSG_REJECT',
  'C2C_MSG_RECEIVE',
  'GROUP_ADD_ROBOT',
  'GROUP_DEL_ROBOT',
  'GROUP_MSG_REJECT',
  'GROUP_MSG_RECEIVE',
  'INTERACTION_CREATE',
])

/**
 * @param {object} options
 * @param {string} options.appId
 * @param {string} options.clientSecret
 * @param {string} [options.baseUrl]         override for tests / sandbox
 * @param {number} [options.intents]
 * @param {object} [options.logger]          { info, warn, error, debug }
 * @param {typeof fetch} [options.fetchImpl]
 * @param {typeof WebSocket} [options.WebSocketImpl]
 * @param {number} [options.maxAttempts]
 * @param {number[]} [options.reconnectDelays]
 */
export function createQQBotLite(options) {
  const {
    appId,
    clientSecret,
    baseUrl,
    intents = Intents.DEFAULT,
    logger = {},
    fetchImpl,
    WebSocketImpl,
    maxAttempts,
    reconnectDelays,
  } = options ?? {}

  const tokenSource = createTokenSource({ appId, clientSecret, baseUrl, fetchImpl })
  const api = createApi({ tokenSource, baseUrl, fetchImpl })

  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()

  function on(event, handler) {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  function emit(event, payload) {
    const set = listeners.get(event)
    if (!set || set.size === 0) return
    for (const handler of [...set]) {
      try {
        handler(payload)
      } catch (error) {
        logger.error?.(`[qqbot-lite] listener for ${event} threw: ${errorText(error)}`)
      }
    }
  }

  const gateway = createGateway({
    tokenSource,
    baseUrl,
    fetchImpl,
    WebSocketImpl,
    intents,
    logger,
    maxAttempts,
    reconnectDelays,
    onEvent: (payload) => {
      const event = normalize(payload)
      if (event.kind === 'message') emit('message', event)
      else if (event.kind === 'control') emit('control', event)
      else emit('event', event)
    },
    onState: (state) => {
      emit('state', state)
      if (state.state === 'ready') emit('ready', { sessionId: state.detail })
    },
  })

  /** Wait for one emitted event, or reject on timeout. */
  function waitFor(event, { timeoutMs = 30_000, predicate } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`等待事件 ${event} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      const off = on(event, (payload) => {
        if (predicate && !predicate(payload)) return
        clearTimeout(timer)
        off()
        resolve(payload)
      })
    })
  }

  return {
    on,
    waitFor,
    start: () => gateway.start(),
    stop: () => gateway.stop(),
    send: api.send,
    sendC2C: api.sendC2C,
    sendGroup: api.sendGroup,
    sendWakeup: api.sendWakeup,
    getToken: tokenSource.getToken,
    get ready() {
      return gateway.ready
    },
    get sessionId() {
      return gateway.sessionId
    },
  }
}

/**
 * Normalize one dispatch into the shape a notification bot consumes.
 * Keeps the raw payload so callers can reach fields we do not model yet.
 */
export function normalize({ t, d, id }) {
  if (t === 'C2C_MESSAGE_CREATE') {
    return {
      kind: 'message',
      scope: 'c2c',
      openid: d?.author?.user_openid,
      msgId: d?.id,
      eventId: id,
      content: typeof d?.content === 'string' ? d.content : '',
      timestamp: d?.timestamp,
      messageScene: d?.message_scene,
      raw: d,
    }
  }
  if (t === 'GROUP_AT_MESSAGE_CREATE') {
    return {
      kind: 'message',
      scope: 'group',
      groupOpenid: d?.group_openid,
      memberOpenid: d?.author?.member_openid,
      msgId: d?.id,
      eventId: id,
      content: typeof d?.content === 'string' ? d.content : '',
      timestamp: d?.timestamp,
      raw: d,
    }
  }
  if (CONTROL_EVENTS.has(t)) {
    return { kind: 'control', t, eventId: id, raw: d }
  }
  return { kind: 'other', t, eventId: id, raw: d }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}
