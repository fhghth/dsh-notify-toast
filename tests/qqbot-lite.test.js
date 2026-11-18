/**
 * Offline tests for qqbot-lite, driven by tools/mock-qq-server.js.
 * Run: node --test tests/
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createMockQQServer } from '../tools/mock-qq-server.js'
import { createTokenSource, TokenError } from '../qqbot-lite/token.js'
import { createApi, QQBotApiError } from '../qqbot-lite/api.js'
import { createQQBotLite, normalize } from '../qqbot-lite/index.js'
import { planCloseRecovery, Intents } from '../qqbot-lite/gateway.js'

const APP_ID = 'mock-app'
const SECRET = 'mock-secret'

async function withMock(options, fn) {
  const mock = createMockQQServer({ appId: APP_ID, clientSecret: SECRET, ...options })
  await mock.listen()
  try {
    return await fn(mock)
  } finally {
    await mock.close()
  }
}

function tokenRequests(mock) {
  return mock.requests.filter((r) => r.path === '/app/getAppAccessToken')
}

// ── token ──────────────────────────────────────────────────────────────────

test('token: caches and reuses one token', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const source = createTokenSource({ appId: APP_ID, clientSecret: SECRET, baseUrl: mock.url })
    assert.equal(await source.getToken(), 'mock-access-token')
    assert.equal(await source.getToken(), 'mock-access-token')
    assert.equal(tokenRequests(mock).length, 1)
  })
})

test('token: refreshes only after the 60s safety margin', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    let clock = 1_000_000
    const source = createTokenSource({
      appId: APP_ID,
      clientSecret: SECRET,
      baseUrl: mock.url,
      now: () => clock,
    })
    await source.getToken()
    clock += 7200_000 - 61_000 // still inside the margin
    await source.getToken()
    assert.equal(tokenRequests(mock).length, 1)
    clock += 2_000 // now inside the final 60s
    await source.getToken()
    assert.equal(tokenRequests(mock).length, 2)
  })
})

test('token: concurrent callers share one request', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const source = createTokenSource({ appId: APP_ID, clientSecret: SECRET, baseUrl: mock.url })
    const results = await Promise.all([source.getToken(), source.getToken(), source.getToken()])
    assert.deepEqual(results, ['mock-access-token', 'mock-access-token', 'mock-access-token'])
    assert.equal(tokenRequests(mock).length, 1)
  })
})

test('token: business error in a 200 body is an error', { timeout: 5000 }, async () => {
  await withMock({ tokenError: { code: 100016, message: 'bad secret' } }, async (mock) => {
    const source = createTokenSource({ appId: APP_ID, clientSecret: SECRET, baseUrl: mock.url })
    await assert.rejects(() => source.getToken(), (error) => {
      assert.ok(error instanceof TokenError)
      assert.equal(error.code, 100016)
      assert.match(error.message, /100016/)
      return true
    })
  })
})

// ── api ────────────────────────────────────────────────────────────────────

function apiFor(mock) {
  const tokenSource = createTokenSource({ appId: APP_ID, clientSecret: SECRET, baseUrl: mock.url })
  return createApi({ tokenSource, baseUrl: mock.url })
}

function lastSendBody(mock) {
  return mock.requests.filter((r) => r.path.includes('/messages')).at(-1)?.body
}

test('api: proactive markdown carries no reply anchor', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const api = apiFor(mock)
    await api.sendC2C('user-openid', { markdown: '# hi' })
    const body = lastSendBody(mock)
    assert.equal(body.msg_type, 2)
    assert.equal(body.markdown.content, '# hi')
    assert.equal(body.msg_id, undefined)
    assert.equal(body.event_id, undefined)
    assert.equal(body.msg_seq, undefined)
  })
})

test('api: passive replies increment msg_seq per msg_id', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const api = apiFor(mock)
    await api.sendC2C('u1', { markdown: 'a', msgId: 'm1' })
    await api.sendC2C('u1', { markdown: 'b', msgId: 'm1' })
    const bodies = mock.requests.filter((r) => r.path.includes('/messages')).map((r) => r.body)
    assert.deepEqual(bodies.map((b) => b.msg_seq), [1, 2])
    assert.deepEqual(bodies.map((b) => b.msg_id), ['m1', 'm1'])
  })
})

test('api: event_id anchors a reply and group uses the group path', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const api = apiFor(mock)
    await api.sendGroup('group-openid', { content: 'hello', eventId: 'EVT1' })
    const request = mock.requests.filter((r) => r.path.includes('/messages')).at(-1)
    assert.equal(request.path, '/v2/groups/group-openid/messages')
    assert.equal(request.body.event_id, 'EVT1')
    assert.equal(request.body.msg_type, 0)
    assert.equal(request.body.content, 'hello')
  })
})

test('api: is_wakeup is a recall message and rejects other anchors', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const api = apiFor(mock)
    await api.sendWakeup('u1', { markdown: 'ping' })
    const body = lastSendBody(mock)
    assert.equal(body.is_wakeup, true)
    assert.equal(body.msg_id, undefined)
    await assert.rejects(() => api.sendC2C('u1', { markdown: 'x', msgId: 'm1', isWakeup: true }))
  })
})

test('api: platform error code maps to a hint', { timeout: 5000 }, async () => {
  await withMock({ sendError: { code: 40034105, message: 'no permission' } }, async (mock) => {
    const api = apiFor(mock)
    await assert.rejects(() => api.sendC2C('u1', { markdown: 'x' }), (error) => {
      assert.ok(error instanceof QQBotApiError)
      assert.equal(error.code, 40034105)
      assert.match(error.hint, /主动消息无权限/)
      return true
    })
  })
})

// ── gateway ────────────────────────────────────────────────────────────────

test('close code policy matches the official table', () => {
  assert.equal(planCloseRecovery(4009), 'resume')
  assert.equal(planCloseRecovery(4006), 'identify-reset')
  assert.equal(planCloseRecovery(4007), 'identify-reset')
  assert.equal(planCloseRecovery(4014), 'fatal')
  assert.equal(planCloseRecovery(4914), 'fatal')
  assert.equal(planCloseRecovery(4915), 'fatal')
  assert.equal(planCloseRecovery(4008), 'identify')
  assert.equal(planCloseRecovery(4901), 'identify')
})

function createBot(mock, extra = {}) {
  return createQQBotLite({
    appId: APP_ID,
    clientSecret: SECRET,
    baseUrl: mock.url,
    reconnectDelays: [10, 20],
    ...extra,
  })
}

test('gateway: identifies with the C2C intents and becomes ready', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const bot = createBot(mock)
    try {
      const ready = bot.waitFor('ready', { timeoutMs: 2000 })
      await bot.start()
      const payload = await ready
      assert.equal(payload.sessionId, 'mock-session')
      const identify = mock.frames.find((f) => f.op === 2)
      assert.ok(identify, 'expected an identify frame')
      assert.equal(identify.d.intents, Intents.DEFAULT)
      assert.deepEqual(identify.d.shard, [0, 1])
      assert.match(identify.d.token, /^QQBot /)
    } finally {
      bot.stop()
    }
  })
})

test('gateway: answers hello heartbeats with the latest seq', { timeout: 5000 }, async () => {
  await withMock({ heartbeatInterval: 20 }, async (mock) => {
    const bot = createBot(mock)
    try {
      await bot.start()
      await bot.waitFor('ready', { timeoutMs: 2000 })
      mock.pushDispatch('C2C_MESSAGE_CREATE', {
        id: 'm1',
        content: 'hi',
        author: { user_openid: 'u1' },
      })
      await bot.waitFor('message', { timeoutMs: 2000 })
      // Wait for at least one heartbeat carrying a seq number.
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        const beat = mock.frames.find((f) => f.op === 1 && typeof f.d === 'number')
        if (beat) {
          assert.ok(beat.d > 0)
          return
        }
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.fail('no heartbeat with a seq was received')
    } finally {
      bot.stop()
    }
  })
})

test('gateway: 4006 drops the session and re-identifies', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const bot = createBot(mock)
    try {
      await bot.start()
      await bot.waitFor('ready', { timeoutMs: 2000 })
      mock.closeSocket(4006)
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        if (mock.frames.filter((f) => f.op === 2).length >= 2) return
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.fail(`expected a second identify, saw ops ${mock.frames.map((f) => f.op).join(',')}`)
    } finally {
      bot.stop()
    }
  })
})

test('gateway: 4014 is fatal and never reconnects', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const bot = createBot(mock)
    const states = []
    bot.on('state', (state) => states.push(state.state))
    try {
      await bot.start()
      await bot.waitFor('ready', { timeoutMs: 2000 })
      mock.closeSocket(4014)
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && !states.includes('fatal')) {
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.ok(states.includes('fatal'), `states=${states.join(',')}`)
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(mock.frames.filter((f) => f.op === 2).length, 1)
    } finally {
      bot.stop()
    }
  })
})

// ── end to end ─────────────────────────────────────────────────────────────

test('end to end: receive a C2C message and reply inside the passive window', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const bot = createBot(mock)
    try {
      await bot.start()
      await bot.waitFor('ready', { timeoutMs: 2000 })
      mock.pushDispatch('C2C_MESSAGE_CREATE', {
        id: 'm1',
        content: 'ping',
        timestamp: '2026-01-01T00:00:00+08:00',
        author: { user_openid: 'u1' },
        message_scene: { ext: [] },
      })
      const message = await bot.waitFor('message', { timeoutMs: 2000 })
      assert.equal(message.scope, 'c2c')
      assert.equal(message.openid, 'u1')
      assert.equal(message.msgId, 'm1')
      assert.equal(message.content, 'ping')

      await bot.sendC2C(message.openid, { markdown: 'pong', msgId: message.msgId })
      const body = lastSendBody(mock)
      assert.equal(body.msg_id, 'm1')
      assert.equal(body.msg_seq, 1)
      assert.equal(body.markdown.content, 'pong')
    } finally {
      bot.stop()
    }
  })
})

test('normalize: group mentions and control events', () => {
  const group = normalize({
    t: 'GROUP_AT_MESSAGE_CREATE',
    id: 'EVT2',
    d: { id: 'm2', group_openid: 'g1', content: 'x', author: { member_openid: 'mem1' } },
  })
  assert.equal(group.scope, 'group')
  assert.equal(group.groupOpenid, 'g1')
  assert.equal(group.memberOpenid, 'mem1')

  const friend = normalize({ t: 'FRIEND_ADD', id: 'EVT3', d: { openid: 'u1' } })
  assert.equal(friend.kind, 'control')
  assert.equal(friend.t, 'FRIEND_ADD')

  const reject = normalize({ t: 'C2C_MSG_REJECT', id: 'EVT4', d: { openid: 'u1' } })
  assert.equal(reject.kind, 'control')
})
