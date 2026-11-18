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
  buildPanelItems,
  buildPanelPayload,
  clipWidth,
  displayWidth,
  formatCardHeader,
  panelSignature,
  selectBoardRows,
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

test('selectBoardRows: unsubscribed finished sessions leave the board', () => {
  const rows = [
    { alias: 1, subscribed: true, running: false },
    { alias: 4, subscribed: false, running: false },
    { alias: 5, subscribed: true, running: true },
    { alias: 6, subscribed: false, running: true },
  ]
  assert.deepEqual(selectBoardRows(rows).map((row) => row.alias), [1, 5, 6])
  assert.deepEqual(selectBoardRows([]), [])
  assert.deepEqual(selectBoardRows(undefined), [])
  assert.deepEqual(selectBoardRows([null, { alias: 9 }]), [])
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
