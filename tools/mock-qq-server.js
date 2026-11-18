/**
 * Offline mock of the QQ Bot OpenAPI + gateway, for tests and probe dry-runs.
 *
 * Implements just enough of the wire protocol to exercise qqbot-lite:
 *   POST /app/getAppAccessToken        -> token (or a business error body)
 *   GET  /gateway                      -> { url }
 *   POST /v2/users/:openid/messages    -> message response (or a business error)
 *   POST /v2/groups/:openid/messages   -> same
 *   WS   /gateway                      -> hello / identify / heartbeat / dispatch
 *
 * The WebSocket server is a minimal RFC 6455 implementation (text frames only,
 * client frames are masked, server frames are not) so the test suite needs no
 * third-party dependency.
 *
 * Usage:
 *   const mock = createMockQQServer()
 *   await mock.listen()
 *   mock.url            // http://127.0.0.1:<port>
 *   mock.frames         // parsed client frames
 *   mock.requests       // HTTP requests
 *   mock.pushDispatch('C2C_MESSAGE_CREATE', { ... })
 *   mock.closeSocket(4006)
 *   await mock.close()
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/**
 * @param {object} [options]
 * @param {number} [options.heartbeatInterval] hello heartbeat interval in ms
 * @param {{ code: number, message?: string }} [options.tokenError]
 * @param {{ code: number, message?: string }} [options.sendError]
 * @param {string} [options.appId]
 * @param {string} [options.clientSecret]
 * @param {boolean} [options.autoReady] send READY automatically on identify
 */
export function createMockQQServer(options = {}) {
  const {
    heartbeatInterval = 50,
    tokenError,
    sendError,
    appId = 'mock-app',
    clientSecret = 'mock-secret',
    autoReady = true,
  } = options

  /** @type {Array<{ method: string, path: string, headers: object, body: any }>} */
  const requests = []
  /** @type {Array<any>} */
  const frames = []
  /** @type {Set<any>} */
  const sockets = new Set()
  let seq = 0
  let messageCounter = 0
  let httpServer
  let baseUrl

  function readBody(req) {
    return new Promise((resolve) => {
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        if (!raw) return resolve(undefined)
        try {
          resolve(JSON.parse(raw))
        } catch {
          resolve(raw)
        }
      })
    })
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const body = await readBody(req)
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, body })

    if (req.method === 'POST' && url.pathname === '/app/getAppAccessToken') {
      if (tokenError) return sendJson(res, 200, { code: tokenError.code, message: tokenError.message })
      if (body?.appId !== appId || body?.clientSecret !== clientSecret) {
        return sendJson(res, 200, { code: 100016, message: 'invalid appId or clientSecret' })
      }
      return sendJson(res, 200, { access_token: 'mock-access-token', expires_in: 7200 })
    }

    if (req.method === 'GET' && url.pathname === '/gateway') {
      return sendJson(res, 200, { url: `${baseUrl.replace(/^http/, 'ws')}/gateway` })
    }

    const messageMatch = url.pathname.match(/^\/v2\/(users|groups)\/([^/]+)\/messages$/)
    if (req.method === 'POST' && messageMatch) {
      if (sendError) return sendJson(res, 200, { code: sendError.code, message: sendError.message })
      if (!req.headers.authorization?.startsWith('QQBot ')) {
        return sendJson(res, 401, { code: 40001, message: 'unauthorized' })
      }
      messageCounter += 1
      return sendJson(res, 200, {
        id: `msg_${messageCounter}`,
        timestamp: new Date().toISOString(),
        ext_info: { ref_idx: `REFIDX_${messageCounter}` },
      })
    }

    return sendJson(res, 404, { code: 404, message: 'not found' })
  }

  function encodeFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8')
    let header
    if (data.length < 126) {
      header = Buffer.from([0x80 | opcode, data.length])
    } else if (data.length < 65_536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(data.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(data.length), 2)
    }
    return Buffer.concat([header, data])
  }

  function sendFrame(socket, opcode, payload) {
    if (!socket || socket.destroyed) return
    try {
      socket.write(encodeFrame(opcode, payload))
    } catch {
      /* socket already gone */
    }
  }

  function sendJsonFrame(socket, payload) {
    sendFrame(socket, OP_TEXT, JSON.stringify(payload))
  }

  /** Decode as many complete client frames as the buffer contains. */
  function decodeFrames(buffer) {
    const out = []
    let offset = 0
    while (offset + 2 <= buffer.length) {
      const first = buffer[offset]
      const second = buffer[offset + 1]
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let cursor = offset + 2
      if (length === 126) {
        if (cursor + 2 > buffer.length) break
        length = buffer.readUInt16BE(cursor)
        cursor += 2
      } else if (length === 127) {
        if (cursor + 8 > buffer.length) break
        length = Number(buffer.readBigUInt64BE(cursor))
        cursor += 8
      }
      let maskKey
      if (masked) {
        if (cursor + 4 > buffer.length) break
        maskKey = buffer.subarray(cursor, cursor + 4)
        cursor += 4
      }
      if (cursor + length > buffer.length) break
      const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4]
      }
      out.push({ opcode, payload })
      offset = cursor + length
    }
    return { frames: out, rest: buffer.subarray(offset) }
  }

  function attachSocket(socket, head) {
    sockets.add(socket)
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      const { frames: parsed, rest } = decodeFrames(pending)
      pending = rest
      for (const frame of parsed) handleFrame(socket, frame)
    })
    socket.on('error', () => sockets.delete(socket))
    socket.on('close', () => sockets.delete(socket))
    sendJsonFrame(socket, { op: 10, d: { heartbeat_interval: heartbeatInterval } })
    // A client may pipeline frames right behind the handshake.
    if (head && head.length > 0) {
      const { frames: parsed, rest } = decodeFrames(Buffer.from(head))
      pending = rest
      for (const frame of parsed) handleFrame(socket, frame)
    }
  }

  function handleFrame(socket, frame) {
    if (frame.opcode === OP_CLOSE) {
      sockets.delete(socket)
      socket.end()
      return
    }
    if (frame.opcode === OP_PING) {
      sendFrame(socket, OP_PONG, frame.payload)
      return
    }
    if (frame.opcode !== OP_TEXT && frame.opcode !== OP_CONTINUATION) return

    let payload
    try {
      payload = JSON.parse(frame.payload.toString('utf8'))
    } catch {
      frames.push({ raw: frame.payload.toString('utf8') })
      return
    }
    frames.push(payload)

    if (payload.op === 1) {
      sendJsonFrame(socket, { op: 11 })
      return
    }
    if (payload.op === 2) {
      if (autoReady) {
        sendJsonFrame(socket, {
          op: 0,
          s: ++seq,
          t: 'READY',
          id: 'EVENT_READY',
          d: { version: 1, session_id: 'mock-session', user: { id: '1', username: 'mock-bot', bot: true }, shard: [0, 1] },
        })
      }
      return
    }
    if (payload.op === 6) {
      sendJsonFrame(socket, { op: 0, s: ++seq, t: 'RESUMED', id: 'EVENT_RESUMED', d: '' })
    }
  }

  function handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key']
    if (!key) {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    )
    attachSocket(socket, head)
  }

  async function listen(port = 0) {
    httpServer = createServer((req, res) => {
      void handleHttp(req, res)
    })
    httpServer.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head))
    await new Promise((resolve) => httpServer.listen(port, '127.0.0.1', resolve))
    const address = httpServer.address()
    baseUrl = `http://127.0.0.1:${address.port}`
    return baseUrl
  }

  async function close() {
    for (const socket of sockets) {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
    sockets.clear()
    if (!httpServer) return
    await new Promise((resolve) => httpServer.close(resolve))
    httpServer = undefined
  }

  /** Push one dispatch to every connected socket. */
  function pushDispatch(t, d, id = `EVENT_${++seq}`) {
    for (const socket of sockets) sendJsonFrame(socket, { op: 0, s: ++seq, t, id, d })
  }

  /** Close every socket with a gateway close code (e.g. 4006 / 4009 / 4014). */
  function closeSocket(code = 1000, reason = '') {
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
    payload.writeUInt16BE(code, 0)
    payload.write(reason, 2)
    for (const socket of sockets) {
      sendFrame(socket, OP_CLOSE, payload)
      socket.end()
    }
    sockets.clear()
  }

  return {
    listen,
    close,
    pushDispatch,
    closeSocket,
    get url() {
      return baseUrl
    },
    get wsUrl() {
      return `${baseUrl?.replace(/^http/, 'ws')}/gateway`
    },
    requests,
    frames,
    get sockets() {
      return sockets
    },
    get openSocketCount() {
      return sockets.size
    },
  }
}
