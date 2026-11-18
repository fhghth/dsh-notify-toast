/**
 * Offline tests for the QQ answer routing rules (qq-answer.js).
 * Run with the package test script: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractRefIdx,
  parseApprovalOutcome,
  parseCommand,
  parseQuestionAnswer,
  selectInboundRoute,
  selectPendingDecision,
} from '../qq-answer.js'

test('approval words map onto the DSH outcome vocabulary', () => {
  for (const word of ['ok', 'OK', 'yes', '允许', '同意', '批准', '通过']) {
    assert.equal(parseApprovalOutcome(word), 'allowed-once', word)
  }
  for (const word of ['no', 'No', 'reject', '拒绝', '驳回', '不同意']) {
    assert.equal(parseApprovalOutcome(word), 'rejected', word)
  }
  assert.equal(parseApprovalOutcome('也许吧'), undefined)
  assert.equal(parseApprovalOutcome(''), undefined)
})

test('quoted card index is read from both QQ shapes', () => {
  assert.equal(
    extractRefIdx({ message_scene: { ext: ['ref_msg_idx=REFIDX_abc'] } }),
    'REFIDX_abc',
  )
  assert.equal(
    extractRefIdx({ message_scene: { ext: ['refMsgIdx:REFIDX_legacy'] } }),
    'REFIDX_legacy',
  )
  assert.equal(extractRefIdx({ msg_elements: [{ msg_idx: 'REFIDX_elem' }] }), 'REFIDX_elem')
  assert.equal(extractRefIdx({ message_scene: { ext: [] } }), undefined)
  assert.equal(extractRefIdx(undefined), undefined)
})

test('question answers: numbers select options, text becomes custom', () => {
  const question = { id: 'q1', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }
  assert.deepEqual(parseQuestionAnswer(question, '2'), { id: 'q1', selected: ['B'] })
  assert.deepEqual(parseQuestionAnswer(question, '9'), { id: 'q1', selected: [], custom: '9' })
  assert.deepEqual(parseQuestionAnswer(question, '1，3'), { id: 'q1', selected: ['A'] })
  assert.deepEqual(parseQuestionAnswer(question, '随便'), { id: 'q1', selected: [], custom: '随便' })

  const multi = { ...question, multiSelect: true }
  assert.deepEqual(parseQuestionAnswer(multi, '1,3'), { id: 'q1', selected: ['A', 'C'] })

  const free = { id: 'q2' }
  assert.deepEqual(parseQuestionAnswer(free, '你好'), { id: 'q2', selected: [], custom: '你好' })
})

const approval = (alias, refIds = []) => ({ alias, refIds })
const question = (alias, refIds = []) => ({ alias, refIds })

test('routing: quoted card wins over the alias prefix', () => {
  const a = approval(1, ['R1'])
  const q = question(2, ['R2'])
  const picked = selectPendingDecision({
    approvals: [a],
    questions: [q],
    refIdx: 'R2',
    text: '#1 ok',
  })
  assert.equal(picked.kind, 'question')
  assert.equal(picked.entry, q)
  assert.equal(picked.payload, 'ok')
})

test('routing: #alias selects the matching session', () => {
  const a1 = approval(1)
  const a2 = approval(2)
  const picked = selectPendingDecision({
    approvals: [a1, a2],
    questions: [],
    text: '#2 no',
  })
  assert.equal(picked.kind, 'approval')
  assert.equal(picked.entry, a2)
  assert.equal(picked.payload, 'no')
})

test('routing: a single pending decision needs no prefix', () => {
  const a = approval(7)
  const picked = selectPendingDecision({ approvals: [a], questions: [], text: 'ok' })
  assert.equal(picked.kind, 'approval')
  assert.equal(picked.entry, a)
})

test('routing: ambiguity is never guessed', () => {
  const picked = selectPendingDecision({
    approvals: [approval(1), approval(2)],
    questions: [],
    text: 'ok',
  })
  assert.equal(picked, undefined)
})

test('routing: prefix without payload stays unconsumed; unknown ref falls back to the sole pending', () => {
  assert.equal(selectPendingDecision({ approvals: [approval(3)], questions: [], text: '#3' }), undefined)

  const only = approval(3)
  const picked = selectPendingDecision({
    approvals: [only],
    questions: [],
    refIdx: 'R9',
    text: 'ok',
  })
  assert.equal(picked.kind, 'approval')
  assert.equal(picked.entry, only)
})

// ── P4: commands and session routing ───────────────────────────────────────

test('commands: slash commands parse independently of pending decisions', () => {
  assert.deepEqual(parseCommand('/ls'), { command: 'ls' })
  assert.deepEqual(parseCommand('/list'), { command: 'ls' })
  assert.deepEqual(parseCommand('/status'), { command: 'status' })
  assert.deepEqual(parseCommand('/off 3'), { command: 'off', alias: 3 })
  assert.deepEqual(parseCommand('/off'), { command: 'off', alias: undefined })
  assert.deepEqual(parseCommand('/wat'), { command: 'help' })
  assert.equal(parseCommand('ok'), undefined)
})

const empty = { approvals: [], questions: [] }

test('route: a quoted notification card routes to its session', () => {
  const route = selectInboundRoute({
    ...empty,
    sentCards: new Map([['REFIDX_1', 'session-a']]),
    aliasSessions: new Map([[3, 'session-a']]),
    refIdx: 'REFIDX_1',
    text: '继续下一步',
  })
  assert.equal(route.kind, 'session')
  assert.equal(route.sessionId, 'session-a')
  assert.equal(route.payload, '继续下一步')
})

test('route: #alias targets a session and keeps the full payload', () => {
  const route = selectInboundRoute({
    ...empty,
    sentCards: new Map(),
    aliasSessions: new Map([[3, 'session-c']]),
    text: '#3 先跑测试再提交',
  })
  assert.equal(route.kind, 'session')
  assert.equal(route.sessionId, 'session-c')
  assert.equal(route.payload, '先跑测试再提交')
})

test('route: unknown #alias and empty payloads answer with an error', () => {
  const unknown = selectInboundRoute({
    ...empty,
    sentCards: new Map(),
    aliasSessions: new Map(),
    text: '#9 hi',
  })
  assert.equal(unknown.kind, 'error')
  assert.match(unknown.message, /#9/)

  const missing = selectInboundRoute({
    ...empty,
    sentCards: new Map(),
    aliasSessions: new Map([[3, 'session-c']]),
    text: '#3',
  })
  assert.equal(missing.kind, 'error')
})

test('route: commands beat decisions and sessions', () => {
  const route = selectInboundRoute({
    approvals: [approval(3)],
    questions: [],
    sentCards: new Map([['R1', 'session-a']]),
    aliasSessions: new Map([[3, 'session-a']]),
    refIdx: 'R1',
    text: '/ls',
  })
  assert.equal(route.kind, 'command')
  assert.equal(route.command, 'ls')
})

test('route: a parked decision beats a session card', () => {
  const pending = approval(3, ['R1'])
  const route = selectInboundRoute({
    approvals: [pending],
    questions: [],
    sentCards: new Map([['R1', 'session-a']]),
    aliasSessions: new Map([[3, 'session-a']]),
    refIdx: 'R1',
    text: 'ok',
  })
  assert.equal(route.kind, 'decision')
  assert.equal(route.decision.entry, pending)
})

test('route: plain text without context is left to the help answer', () => {
  assert.equal(
    selectInboundRoute({ ...empty, sentCards: new Map(), aliasSessions: new Map(), text: '随便聊聊' }),
    undefined,
  )
  assert.equal(
    selectInboundRoute({ ...empty, sentCards: new Map(), aliasSessions: new Map(), text: '' }),
    undefined,
  )
})
