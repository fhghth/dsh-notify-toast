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
  summarizeUsage,
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

// ── usage roll-up ──────────────────────────────────────────────────────────

function withUsage(seq, usage) {
  return { type: 'assistant/message', seq, data: { usage, message: { content: [] } } }
}

test('summarizeUsage: counts turns and steps from the log', () => {
  const summary = summarizeUsage(session)
  assert.equal(summary.turns, 1)
  assert.equal(summary.steps, 0)
  const dense = [
    { type: 'turn/end', seq: 1 },
    { type: 'step/end', seq: 2 },
    { type: 'step/end', seq: 3 },
    { type: 'turn/end', seq: 4 },
  ]
  const s = summarizeUsage(dense)
  assert.equal(s.turns, 2)
  assert.equal(s.steps, 2)
})

test('summarizeUsage: sums provider usage and derives the cache hit rate', () => {
  const events = [
    withUsage(1, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 9000, cacheWriteTokens: 0, totalTokens: 10200 }),
    withUsage(2, { inputTokens: 0, outputTokens: 100, cacheReadTokens: 10000, cacheWriteTokens: 0, totalTokens: 10100 }),
  ]
  const s = summarizeUsage(events)
  assert.equal(s.inputTokens, 1000)
  assert.equal(s.outputTokens, 300)
  assert.equal(s.cacheReadTokens, 19000)
  assert.equal(s.totalTokens, 20300)
  assert.ok(Math.abs(s.cacheHit - 19000 / 20000) < 1e-9)
})

test('summarizeUsage: no usage facts means no cache rate', () => {
  const s = summarizeUsage([{ type: 'turn/end', seq: 1 }])
  assert.equal(s.cacheHit, undefined)
  assert.equal(s.totalTokens, 0)
})

test('summarizeUsage: honours the sequence range', () => {
  const events = [
    withUsage(1, { inputTokens: 10, outputTokens: 1, totalTokens: 11 }),
    withUsage(2, { inputTokens: 20, outputTokens: 2, totalTokens: 22 }),
    { type: 'turn/end', seq: 3 },
  ]
  const only = summarizeUsage(events, { fromSeq: 2, toSeq: 3 })
  assert.equal(only.inputTokens, 20)
  assert.equal(only.turns, 1)
  assert.equal(only.steps, 0)
})

test('summarizeUsage: tolerates garbage', () => {
  assert.equal(summarizeUsage(undefined).turns, 0)
  assert.equal(summarizeUsage([null, {}, { type: 'assistant/message', seq: 1, data: {} }]).totalTokens, 0)
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
