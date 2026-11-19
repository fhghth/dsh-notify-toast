/**
 * Offline tests for the 指令面板 builder and its API wrapper.
 * Run: node --test "tests/**\/*.test.js"
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createMockQQServer } from '../tools/mock-qq-server.js'
import { createTokenSource } from '../qqbot-lite/token.js'
import { createApi } from '../qqbot-lite/api.js'
import { createPanelApi, isPanelGone, PANEL_GONE_CODE } from '../qqbot-lite/panel.js'
import {
  allocateAlias,
  buildPanelItems,
  buildPanelPayload,
  clipWidth,
  displayWidth,
  formatCardHeader,
  migrateQQState,
  panelSignature,
  selectStaleSubscriptions,
  stateBadge,
  PANEL_DESC_LIMIT,
  PANEL_ITEM_LIMIT,
  PANEL_NAME_LIMIT,
  PANEL_REMARK,
} from '../qq-panel.js'
import { parseCommand } from '../qq-answer.js'

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

function panelApiFor(mock) {
  const tokenSource = createTokenSource({ appId: APP_ID, clientSecret: SECRET, baseUrl: mock.url })
  const api = createApi({ tokenSource, baseUrl: mock.url })
  return createPanelApi(api.request)
}

test('allocateAlias: reuses the lowest freed number', () => {
  assert.equal(allocateAlias([]), 1)
  assert.equal(allocateAlias([1]), 2)
  assert.equal(allocateAlias([1, 5]), 2)
  assert.equal(allocateAlias(new Set([2, 3, 4])), 1)
  assert.equal(allocateAlias([0, -1, 'x', null]), 1)
  assert.equal(allocateAlias(undefined), 1)
})

test('migrateQQState: drops alias-only entries left by the /ls side effect', () => {
  const migrated = migrateQQState({
    version: 2,
    aliasSeq: 6,
    subscriptions: { s1: { on: true, alias: 1, since: 10 } },
    aliases: { s1: 1, s4: 4, s5: 5, s6: 6 },
    learnedOpenids: ['u1'],
    panelId: 'p1',
  })
  assert.equal(migrated.version, 3)
  assert.deepEqual(Object.keys(migrated.subscriptions), ['s1'])
  assert.deepEqual(migrated.subscriptions.s1, { alias: 1, since: 10, lastLiveAt: 0, title: '' })
  assert.deepEqual(migrated.learnedOpenids, ['u1'])
  assert.equal(migrated.panelId, 'p1')
})

test('migrateQQState: duplicate aliases are renumbered, existing ones are kept', () => {
  const migrated = migrateQQState({
    subscriptions: {
      a: { on: true, alias: 2, since: 1 },
      b: { on: true, alias: 2, since: 2 },
      c: { on: true, since: 3 },
    },
    aliases: { c: 7 },
  })
  const aliases = Object.values(migrated.subscriptions).map((entry) => entry.alias)
  assert.equal(new Set(aliases).size, aliases.length)
  assert.ok(aliases.every((number) => Number.isInteger(number) && number > 0))
  // The first holder of 2 keeps it, the second moves to the lowest free number,
  // and an alias already recorded in the old table is preserved.
  assert.equal(migrated.subscriptions.a.alias, 2)
  assert.equal(migrated.subscriptions.b.alias, 1)
  assert.equal(migrated.subscriptions.c.alias, 7)
})

test('migrateQQState: tolerates garbage and old shapes', () => {
  assert.deepEqual(migrateQQState(undefined).subscriptions, {})
  assert.deepEqual(migrateQQState('nope').subscriptions, {})
  assert.deepEqual(
    migrateQQState({ subscriptions: { a: { on: false, alias: 1 } } }).subscriptions,
    {},
  )
  const legacy = migrateQQState({ subscriptions: { a: 1 } })
  assert.equal(legacy.subscriptions.a.alias, 1)
  assert.deepEqual(legacy.closed, { labels: {}, refs: [] })
})

test('migrateQQState: the closed-card record survives a round trip', () => {
  const migrated = migrateQQState({
    subscriptions: { a: { alias: 1 } },
    closed: {
      labels: { a: ['方案一', '方案二'], b: 'nope', c: [42, '方案三'] },
      refs: ['REF1', '', 7, 'REF2'],
    },
  })
  // A card cannot be recalled, so forgetting what closed would let a stale
  // chip tap answer the wrong question after a reload.
  assert.deepEqual(migrated.closed.labels, { a: ['方案一', '方案二'], c: ['方案三'] })
  assert.deepEqual(migrated.closed.refs, ['REF1', 'REF2'])
})

test('selectStaleSubscriptions: only cold subscriptions past the TTL are retired', () => {
  const day = 86_400_000
  const now = 100 * day
  const rows = [
    { sessionId: 'live-old', live: true, lastLiveAt: now - 40 * day },
    { sessionId: 'cold-old', live: false, lastLiveAt: now - 40 * day },
    { sessionId: 'cold-new', live: false, lastLiveAt: now - day },
    { sessionId: 'cold-legacy', live: false, since: now - 31 * day },
    { sessionId: 'cold-unknown', live: false },
  ]
  assert.deepEqual(selectStaleSubscriptions(rows, now, 30 * day), ['cold-old', 'cold-legacy'])
})

test('selectStaleSubscriptions: a zero TTL disables the sweep entirely', () => {
  const rows = [{ sessionId: 'a', live: false, lastLiveAt: 1 }]
  assert.deepEqual(selectStaleSubscriptions(rows, 1e12, 0), [])
  assert.deepEqual(selectStaleSubscriptions(rows, 1e12, -5), [])
  assert.deepEqual(selectStaleSubscriptions(undefined, 1e12, 86_400_000), [])
  assert.deepEqual(selectStaleSubscriptions([null, {}], 1e12, 86_400_000), [])
})

// ── card header ────────────────────────────────────────────────────────────

test('formatCardHeader: emoji + anchor + status, so one line identifies a card', () => {
  assert.equal(
    formatCardHeader('✅', 3, '修复登录超时', '会话完成'),
    '✅ **#3 · 修复登录超时** · 会话完成',
  )
  assert.equal(formatCardHeader('⚠️', 7, '迁移脚本', '任务失败'), '⚠️ **#7 · 迁移脚本** · 任务失败')
  assert.equal(formatCardHeader('', 2, '重构路由', ''), '**#2 · 重构路由**')
})

test('formatCardHeader: an unknown alias still yields a readable title', () => {
  assert.equal(formatCardHeader('✅', 0, '孤立会话', '会话完成'), '✅ **孤立会话** · 会话完成')
  assert.equal(formatCardHeader('✅', 0, '', ''), '✅ **新对话**')
})

// ── width math ─────────────────────────────────────────────────────────────

test('displayWidth: CJK and emoji count as two columns', () => {
  assert.equal(displayWidth('abc'), 3)
  assert.equal(displayWidth('会话'), 4)
  // `#`, digits, spaces and the middle dot are single-column.
  assert.equal(displayWidth('#3 · 登录超时'), 13)
  assert.equal(displayWidth('✅'), 2)
  assert.equal(displayWidth(''), 0)
})

test('clipWidth: keeps short strings, truncates long ones with an ellipsis', () => {
  assert.equal(clipWidth('短', 10), '短')
  assert.equal(displayWidth(clipWidth('一二三四五六七八', 10)), 9)
  assert.ok(clipWidth('一二三四五六七八', 10).endsWith('…'))
  // Never exceeds the budget it was given.
  for (const limit of [1, 2, 3, 6, 14, 30]) {
    assert.ok(displayWidth(clipWidth('很长的标题'.repeat(10), limit)) <= limit)
  }
})

// ── panel items ────────────────────────────────────────────────────────────

test('stateBadge: every state has a badge and unknown falls back to idle', () => {
  assert.match(stateBadge('approval'), /待审批/)
  assert.match(stateBadge('running'), /运行中/)
  assert.match(stateBadge('completed'), /完成/)
  assert.equal(stateBadge('whatever'), stateBadge('idle'))
})

test('buildPanelItems: urgent sessions come first, then running, then done', () => {
  const items = buildPanelItems([
    { alias: 1, title: '已完成', state: 'completed' },
    { alias: 2, title: '空闲', state: 'idle' },
    { alias: 3, title: '运行中', state: 'running' },
    { alias: 4, title: '等审批', state: 'approval' },
  ])
  const names = items.map((item) => item.name)
  assert.deepEqual(names, ['/s 4', '/s 3', '/s 1', '/s 2', '/ls', '/status'])
})

test('buildPanelItems: cold sessions sort last but are still listed', () => {
  const items = buildPanelItems([
    { alias: 2, title: '冷的', state: 'cold' },
    { alias: 3, title: '在跑', state: 'running' },
    { alias: 4, title: '等审批', state: 'approval' },
  ])
  assert.deepEqual(items.map((item) => item.name), ['/s 4', '/s 3', '/s 2', '/ls', '/status'])
  assert.match(items[2].desc, /未打开/)
})

test('buildPanelItems: item names are commands and stay inside the limits', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    alias: index + 1,
    title: `这是一个很长很长的会话标题${index}`,
    state: 'running',
  }))
  const items = buildPanelItems(rows)
  assert.equal(items.length, PANEL_ITEM_LIMIT)
  for (const item of items) {
    assert.equal(item.type, 'command')
    assert.ok(displayWidth(item.name) <= PANEL_NAME_LIMIT, `name too wide: ${item.name}`)
    assert.ok(displayWidth(item.desc) <= PANEL_DESC_LIMIT, `desc too wide: ${item.desc}`)
  }
})

test('buildPanelItems: utility entries are always last and always present', () => {
  const many = Array.from({ length: 19 }, (_, index) => ({
    alias: index + 1,
    title: `会话${index}`,
    state: 'idle',
  }))
  const items = buildPanelItems(many)
  assert.equal(items.length, PANEL_ITEM_LIMIT)
  assert.equal(items.at(-2).name, '/ls')
  assert.equal(items.at(-1).name, '/status')

  // A full board keeps the two utilities and shows 18 sessions instead of 20,
  // because /ls is how you reach the sessions that did not fit.
  const full = Array.from({ length: 20 }, (_, index) => ({
    alias: index + 1,
    title: `会话${index}`,
    state: 'idle',
  }))
  const dense = buildPanelItems(full)
  assert.equal(dense.length, PANEL_ITEM_LIMIT)
  assert.equal(dense.filter((item) => item.name.startsWith('/s ')).length, PANEL_ITEM_LIMIT - 2)
  assert.equal(dense.at(-2).name, '/ls')
})

test('buildPanelItems: rows without a positive alias are ignored', () => {
  const items = buildPanelItems([
    { alias: 0, title: 'x', state: 'idle' },
    { alias: -1, title: 'y', state: 'idle' },
    { alias: 7, title: 'z', state: 'running' },
  ])
  assert.deepEqual(items.map((item) => item.name), ['/s 7', '/ls', '/status'])
})

test('buildPanelPayload: carries the remark used to find the board again', () => {
  const payload = buildPanelPayload([{ alias: 3, title: 't', state: 'running' }])
  assert.equal(payload.remark, PANEL_REMARK)
  assert.equal(payload.items[0].name, '/s 3')
})

test('panelSignature: stable for equal content, different otherwise', () => {
  const a = buildPanelItems([{ alias: 1, title: 't', state: 'running' }])
  const b = buildPanelItems([{ alias: 1, title: 't', state: 'running' }])
  const c = buildPanelItems([{ alias: 1, title: 't', state: 'completed' }])
  assert.equal(panelSignature(a), panelSignature(b))
  assert.notEqual(panelSignature(a), panelSignature(c))
})

// ── /s command ─────────────────────────────────────────────────────────────

test('parseCommand: /s and /show carry the alias', () => {
  assert.deepEqual(parseCommand('/s 3'), { command: 's', alias: 3 })
  assert.deepEqual(parseCommand('/show 12'), { command: 's', alias: 12 })
  assert.deepEqual(parseCommand('/s'), { command: 's', alias: undefined })
  assert.deepEqual(parseCommand('/s x'), { command: 's', alias: undefined })
})

test('parseCommand: accepts the slashless form a 指令面板 tap produces', () => {
  // QQ stores panel item names without the leading slash.
  assert.deepEqual(parseCommand('s 3'), { command: 's', alias: 3 })
  assert.deepEqual(parseCommand('show 7'), { command: 's', alias: 7 })
  assert.deepEqual(parseCommand('ls'), { command: 'ls' })
  assert.deepEqual(parseCommand('status'), { command: 'status' })
  assert.deepEqual(parseCommand('off 4'), { command: 'off', alias: 4 })
})

test('parseCommand: ordinary chat text is never a bare command', () => {
  assert.equal(parseCommand('ls -la'), undefined)
  assert.equal(parseCommand('s 3 please refactor'), undefined)
  assert.equal(parseCommand('status report'), undefined)
  assert.equal(parseCommand('s3'), undefined)
  assert.equal(parseCommand('#3 hello'), undefined)
  assert.equal(parseCommand(''), undefined)
})

// ── panel API ──────────────────────────────────────────────────────────────

test('panel api: create sends the scope, target list and remark', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const panels = panelApiFor(mock)
    const id = await panels.create({
      scope: 'c2c',
      targetType: 'specific',
      userOpenids: ['u1'],
      panel: { items: [{ type: 'command', name: '/ls', desc: '全部会话' }], remark: PANEL_REMARK },
    })
    assert.ok(id)
    const request = mock.requests.filter((r) => r.path === '/v2/panels' && r.method === 'POST').at(-1)
    assert.equal(request.body.scope, 'c2c')
    assert.equal(request.body.target_type, 'specific')
    assert.deepEqual(request.body.user_openids, ['u1'])
    assert.equal(request.body.panel.remark, PANEL_REMARK)
  })
})

test('panel api: list filters by scope and reads records', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const panels = panelApiFor(mock)
    await panels.create({ scope: 'c2c', panel: { items: [], remark: PANEL_REMARK } })
    const records = await panels.list('c2c')
    assert.equal(records.length, 1)
    assert.equal(records[0].panel.remark, PANEL_REMARK)
    const listed = mock.requests.filter((r) => r.path === '/v2/panels' && r.method === 'GET').at(-1)
    assert.match(listed.headers.authorization, /^QQBot /)
  })
})

test('panel api: update replaces items without touching the target list', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const panels = panelApiFor(mock)
    const id = await panels.create({
      scope: 'c2c',
      targetType: 'specific',
      userOpenids: ['u1'],
      panel: { items: [], remark: PANEL_REMARK },
    })
    await panels.update(id, {
      items: [{ type: 'command', name: '/s 2', desc: '运行中' }],
      remark: PANEL_REMARK,
    })
    const detail = await panels.get(id)
    assert.equal(detail.panel.items[0].name, '/s 2')
    assert.deepEqual(detail.user_openids, ['u1'])
    assert.equal(mock.requests.filter((r) => r.path === `/v2/panels/${id}` && r.method === 'PUT').length, 1)
  })
})

test('panel api: a deleted panel reports the gone code', { timeout: 5000 }, async () => {
  await withMock({}, async (mock) => {
    const panels = panelApiFor(mock)
    const id = await panels.create({ scope: 'c2c', panel: { items: [], remark: PANEL_REMARK } })
    mock.dropPanel(id)
    await assert.rejects(() => panels.update(id, { items: [] }), (error) => {
      assert.ok(isPanelGone(error))
      assert.equal(error.code, PANEL_GONE_CODE)
      return true
    })
  })
})

test('panel api: platform failure surfaces as a code, not a gone panel', { timeout: 5000 }, async () => {
  await withMock({ panelError: { code: 40030013, message: 'limit' } }, async (mock) => {
    const panels = panelApiFor(mock)
    await assert.rejects(() => panels.list('c2c'), (error) => {
      assert.equal(error.code, 40030013)
      assert.equal(isPanelGone(error), false)
      return true
    })
  })
})
