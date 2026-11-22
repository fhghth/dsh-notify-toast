/**
 * QQ Bot OpenAPI message sending (zero dependencies).
 *
 * Official contract (api-v2 / 发送单聊消息):
 *   POST {baseUrl}/v2/users/{user_openid}/messages
 *   POST {baseUrl}/v2/groups/{group_openid}/messages
 *
 * Message classes:
 *   - 被动回复   msg_id  or event_id       (60min / 4 replies per C2C message)
 *   - 互动召回   is_wakeup                 (mutually exclusive with the two above)
 *   - 主动消息   none of them              (rate limited per user/day)
 *
 * The three anchors are mutually exclusive; msg_seq increments per msg_id and
 * repeating the same msg_id+msg_seq is rejected by the platform.
 */

const DEFAULT_BASE_URL = 'https://api.bot.qq.com'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_USER_AGENT = 'dsh-qqbot-lite/0.1 (+dsh-notify-toast)'
/** Keep the seq map bounded; it is only a de-dup guard within one process. */
const MAX_TRACKED_MSG_IDS = 1000

export const MsgType = {
  TEXT: 0,
  MARKDOWN: 2,
  MEDIA: 7,
  CARD: 8,
}

/** Platform codes worth translating into a human hint. */
const CODE_HINTS = {
  40034005: 'msg_id 已过期：被动回复窗口（私聊 60 分钟）已过',
  40034100: '主动消息触发频控，请降低发送频率或等待配额恢复',
  40034105: '主动消息无权限：该机器人未获得主动消息能力',
  40034122: '互动召回消息已达区间上限（30 天内 4 个周期各 1 条）',
  40034127: '无 markdown 模板权限',
  40034128: '被动回复时间或次数超限（同一 msg_id 最多 4 次）',
  40054004: '无好友关系：请先让用户添加机器人好友',
  40054005: '消息被去重：同一 msg_id + msg_seq 重复发送',
  40054006: '验证好友关系失败',
  40054007: '消息长度超限',
  40054013: '用户已在 QQ 客户端关闭「允许主动发送」',
  40054016: '机器人已下线',
  304076: '接收者 openid 无效（是不是把 AppID 填成了 openid）',
}

export class QQBotApiError extends Error {
  constructor(message, { code, status, body } = {}) {
    super(message)
    this.name = 'QQBotApiError'
    this.code = code
    this.status = status
    this.body = body
    this.hint = code === undefined ? undefined : CODE_HINTS[code]
  }
}

/**
 * @param {object} options
 * @param {{ getToken: (opts?: { force?: boolean }) => Promise<string>, invalidate: () => void }} options.tokenSource
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.userAgent]
 * @param {number} [options.timeoutMs]
 */
export function createApi(options) {
  const {
    tokenSource,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options ?? {}

  if (!tokenSource || typeof tokenSource.getToken !== 'function') {
    throw new QQBotApiError('createApi requires a tokenSource')
  }
  if (typeof fetchImpl !== 'function') throw new QQBotApiError('global fetch is unavailable')

  /** @type {Map<string, number>} msg_id -> last allocated msg_seq */
  const seqByMsgId = new Map()

  function nextMsgSeq(msgId) {
    const next = (seqByMsgId.get(msgId) ?? 0) + 1
    seqByMsgId.delete(msgId)
    seqByMsgId.set(msgId, next)
    if (seqByMsgId.size > MAX_TRACKED_MSG_IDS) {
      const oldest = seqByMsgId.keys().next().value
      if (oldest !== undefined) seqByMsgId.delete(oldest)
    }
    return next
  }

  function messagePath(scope, targetId) {
    if (!targetId) throw new QQBotApiError('targetId is required')
    if (scope === 'c2c') return `/v2/users/${encodeURIComponent(targetId)}/messages`
    if (scope === 'group') return `/v2/groups/${encodeURIComponent(targetId)}/messages`
    throw new QQBotApiError(`unsupported scope: ${scope}`)
  }

  async function readJson(response) {
    const text = await response.text()
    if (!text) return undefined
    try {
      return JSON.parse(text)
    } catch {
      throw new QQBotApiError(`返回了非 JSON 响应 (HTTP ${response.status})`, {
        status: response.status,
      })
    }
  }

  function assertOk(status, body) {
    if (body && typeof body.code === 'number' && body.code !== 0) {
      const message = body.message ? String(body.message) : 'unknown error'
      const hint = CODE_HINTS[body.code]
      throw new QQBotApiError(
        `QQ OpenAPI 拒绝：code=${body.code} ${message}` + (hint ? `（${hint}）` : ''),
        { code: body.code, status, body },
      )
    }
    if (status >= 400) {
      throw new QQBotApiError(`QQ OpenAPI HTTP ${status}`, { status, body })
    }
  }

  /**
   * Send one message.
   *
   * @param {object} options
   * @param {'c2c'|'group'} [options.scope]
   * @param {string} options.targetId              user openid (c2c) or group openid
   * @param {string} [options.markdown]            markdown body (msg_type=2)
   * @param {string} [options.content]             plain text body (msg_type=0)
   * @param {string} [options.msgId]               passive reply anchor
   * @param {string} [options.eventId]             passive reply anchor (event)
   * @param {boolean} [options.isWakeup]           interaction-recall message (c2c only)
   * @param {number} [options.msgSeq]              override; defaults to per-msg_id counter
   * @param {object} [options.keyboard]            inline keyboard
   * @param {object} [options.messageReference]    { message_id } quote
   */
  async function send(options) {
    const {
      scope = 'c2c',
      targetId,
      markdown,
      content,
      msgId,
      eventId,
      isWakeup = false,
      msgSeq,
      keyboard,
      messageReference,
    } = options ?? {}

    const anchors = [msgId, eventId, isWakeup ? true : undefined].filter((v) => v !== undefined)
    if (anchors.length > 1) {
      throw new QQBotApiError('msg_id / event_id / is_wakeup 互斥，只能选一个')
    }
    if (markdown !== undefined && content !== undefined) {
      throw new QQBotApiError('markdown 与 content 互斥')
    }
    if (markdown === undefined && content === undefined) {
      throw new QQBotApiError('必须提供 markdown 或 content')
    }
    if (isWakeup && scope !== 'c2c') {
      throw new QQBotApiError('is_wakeup 仅支持单聊')
    }

    const body = {}
    if (markdown !== undefined) {
      body.msg_type = MsgType.MARKDOWN
      body.markdown = { content: markdown }
    } else {
      body.msg_type = MsgType.TEXT
      body.content = content
    }
    if (msgId !== undefined) {
      body.msg_id = msgId
      body.msg_seq = msgSeq ?? nextMsgSeq(msgId)
    } else if (eventId !== undefined) {
      body.event_id = eventId
      body.msg_seq = msgSeq ?? 1
    } else if (isWakeup) {
      body.is_wakeup = true
    }
    if (keyboard !== undefined) body.keyboard = keyboard
    if (messageReference !== undefined) body.message_reference = messageReference

    const path = messagePath(scope, targetId)
    const parsed = await request('POST', path, body)
    return {
      id: parsed?.id,
      timestamp: parsed?.timestamp,
      refIdx: parsed?.ext_info?.ref_idx,
      raw: parsed,
    }
  }

  /**
   * One authenticated OpenAPI call. 401 gets a single silent retry with a
   * forced token refresh, which is the only failure worth repeating.
   *
   * @param {'GET'|'POST'|'PUT'|'DELETE'} method
   * @param {string} path  path including the query string
   * @param {object} [body]
   */
  async function request(method, path, body) {
    let token = await tokenSource.getToken()
    let response = await dispatch(method, path, body, token)
    if (response.status === 401) {
      tokenSource.invalidate()
      token = await tokenSource.getToken({ force: true })
      response = await dispatch(method, path, body, token)
    }
    const parsed = await readJson(response)
    assertOk(response.status, parsed)
    return parsed
  }

  async function dispatch(method, path, body, token) {
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `QQBot ${token}`,
          'content-type': 'application/json',
          'user-agent': userAgent,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new QQBotApiError(
        `请求失败(${method} ${path})：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const sendC2C = (targetId, payload) => send({ ...payload, scope: 'c2c', targetId })
  const sendGroup = (targetId, payload) => send({ ...payload, scope: 'group', targetId })
  const sendWakeup = (targetId, payload) =>
    send({ ...payload, scope: 'c2c', targetId, isWakeup: true })

  return { send, sendC2C, sendGroup, sendWakeup, nextMsgSeq, request }
}
