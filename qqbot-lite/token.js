/**
 * QQ Bot access-token source.
 *
 * Official contract (api-v2 / 接口调用与鉴权):
 *   POST {baseUrl}/app/getAppAccessToken  { appId, clientSecret }
 *   -> { access_token, expires_in }
 *
 * Rules we must respect:
 *   - A token lives ~7200s and is NOT re-issued per request.
 *   - Asking again during the final 60s returns a new token; the old one stays
 *     valid for that window. So we refresh with a 60s safety margin.
 *   - HTTP 200 can still carry an error body (`code`/`message`), so the status
 *     code alone proves nothing.
 */

const DEFAULT_BASE_URL = 'https://api.bot.qq.com'
/** Refresh when less than this remains; matches the platform's 60s rotation. */
const REFRESH_MARGIN_MS = 60_000
const DEFAULT_TIMEOUT_MS = 15_000

export class TokenError extends Error {
  constructor(message, { code, status, body } = {}) {
    super(message)
    this.name = 'TokenError'
    this.code = code
    this.status = status
    this.body = body
  }
}

/**
 * Create a token source.
 *
 * @param {object} options
 * @param {string} options.appId
 * @param {string} options.clientSecret
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]  injectable clock for tests
 * @param {number} [options.timeoutMs]
 */
export function createTokenSource(options) {
  const {
    appId,
    clientSecret,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options ?? {}

  if (!appId) throw new TokenError('appId is required')
  if (!clientSecret) throw new TokenError('clientSecret is required')
  if (typeof fetchImpl !== 'function') throw new TokenError('global fetch is unavailable')

  /** @type {{ token: string, expiresAt: number } | null} */
  let cached = null
  /** @type {Promise<{ token: string, expiresAt: number }> | null} */
  let inflight = null

  async function requestToken() {
    let response
    try {
      response = await fetchImpl(`${baseUrl}/app/getAppAccessToken`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new TokenError(`获取 access_token 失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const text = await response.text()
    let body
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      throw new TokenError(`获取 access_token 返回了非 JSON 响应 (HTTP ${response.status})`, {
        status: response.status,
      })
    }

    // QQ reports business failures in the body; HTTP status may still be 200.
    if (body && typeof body.code === 'number' && body.code !== 0) {
      throw new TokenError(
        `获取 access_token 被拒绝：code=${body.code}${body.message ? ` ${body.message}` : ''}`,
        { code: body.code, status: response.status, body },
      )
    }
    if (!body || typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new TokenError(`获取 access_token 响应缺少 access_token (HTTP ${response.status})`, {
        status: response.status,
        body,
      })
    }

    const expiresInSeconds = Number(body.expires_in) > 0 ? Number(body.expires_in) : 7200
    return {
      token: body.access_token,
      expiresAt: now() + expiresInSeconds * 1000 - REFRESH_MARGIN_MS,
    }
  }

  /**
   * Return a usable token, refreshing when near expiry.
   * Concurrent callers share one request (singleflight).
   */
  async function getToken({ force = false } = {}) {
    if (!force && cached && cached.expiresAt > now()) return cached.token
    if (!inflight) {
      inflight = requestToken()
        .then((next) => {
          cached = next
          return next
        })
        .finally(() => {
          inflight = null
        })
    }
    const value = await inflight
    return value.token
  }

  /** Drop the cache (e.g. after a 401 from the OpenAPI). */
  function invalidate() {
    cached = null
  }

  function peek() {
    return cached ? { token: cached.token, expiresAt: cached.expiresAt } : null
  }

  return { getToken, invalidate, peek }
}
