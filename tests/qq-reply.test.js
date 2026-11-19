/**
 * Offline tests for the assistant-text extraction used by QQ cards.
 * Run: node --test "tests/**\/*.test.js"
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectAssistantText,
  fitMessage,
  pendingReplyText,
  turnReplyText,
  turnStartSeq,
} from '../qq-reply.js'

function assistant(seq, texts, extra = {}) {
  return {
    type: 'assistant/message',
    seq,
    data: {
      turn: 1,
      ...extra,
      message: {
        role: 'assistant',
        content: [
          ...texts.map((text) => ({ type: 'reasoning', text: `思考-${text}` })),
          ...texts.map((text) => ({ type: 'text', text })),
        ],
      },
    },
  }
}

const session = [
  { type: 'turn/start', seq: 1 },
  assistant(2, ['第一段']),
  { type: 'tool/call', seq: 3, data: {} },
  assistant(4, ['第二段']),
  { type: 'turn/end', seq: 5, data: { reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 6 },
  assistant(7, ['第三段']),
]

// ── turn bounds ────────────────────────────────────────────────────────────

test('turnStartSeq: finds the turn that a turn/end closes', () => {
  assert.equal(turnStartSeq(session, 5), 1)
  assert.equal(turnStartSeq(session, 7), 6)
  assert.equal(turnStartSeq(session, 0), 0)
  assert.equal(turnStartSeq([], 5), 0)
})

// ── extraction ─────────────────────────────────────────────────────────────

test('collectAssistantText: keeps text blocks and drops reasoning', () => {
  const text = collectAssistantText(session)
  assert.equal(text, '第一段\n\n第二段\n\n第三段')
  assert.ok(!text.includes('思考-'))
})

test('collectAssistantText: honours the sequence range', () => {
  assert.equal(collectAssistantText(session, { fromSeq: 1, toSeq: 5 }), '第一段\n\n第二段')
  assert.equal(collectAssistantText(session, { fromSeq: 6 }), '第三段')
  assert.equal(collectAssistantText(session, { fromSeq: 4, toSeq: 4 }), '第二段')
})

test('collectAssistantText: skips empty, malformed and non-text blocks', () => {
  const events = [
    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '   ' }] } } },
    { type: 'assistant/message', seq: 2, data: {} },
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'tool-call' }] } } },
    { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'tool/result', seq: 5 },
    null,
  ]
  assert.equal(collectAssistantText(events), 'ok')
  assert.equal(collectAssistantText(undefined), '')
})

test('turnReplyText: only the turn closed by that turn/end', () => {
  assert.equal(turnReplyText(session, 5), '第一段\n\n第二段')
  assert.equal(turnReplyText(session, 7), '第三段')
})

test('pendingReplyText: everything since the current turn started', () => {
  assert.equal(pendingReplyText(session), '第三段')
  assert.equal(pendingReplyText(session, 5), '第一段\n\n第二段')
  // An approval asked before the model said anything yields an empty body.
  assert.equal(pendingReplyText([{ type: 'turn/start', seq: 1 }, { type: 'approval/asked', seq: 2 }], 2), '')
})

// ── last-resort truncation ─────────────────────────────────────────────────

test('fitMessage: leaves short text alone', () => {
  const fitted = fitMessage('短文本', 100)
  assert.equal(fitted.truncated, false)
  assert.equal(fitted.text, '短文本')
  // 0 disables the cap entirely.
  assert.equal(fitMessage('abc', 0).truncated, false)
})

test('fitMessage: keeps head and tail and stays inside the budget', () => {
  const body = 'A'.repeat(2000) + 'TAIL'
  const fitted = fitMessage(body, 300)
  assert.equal(fitted.truncated, true)
  assert.ok(fitted.text.startsWith('AAA'))
  assert.ok(fitted.text.endsWith('TAIL'))
  assert.ok(fitted.text.includes('已省略'))
  assert.ok(fitted.text.length < 300 + 80)
})
