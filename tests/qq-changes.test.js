import assert from 'node:assert/strict'
import test from 'node:test'

import { cell, changesSeqOfTurn, fileRows, markdownTable } from '../qq-changes.js'

test('cell: pipes and newlines cannot break the row', () => {
  assert.equal(cell('a|b'), 'a｜b')
  assert.equal(cell('line1\nline2'), 'line1 line2')
  assert.equal(cell('  值  '), '值')
  // An empty cell would collapse to `|  |`, which QQ renders as a broken table.
  assert.equal(cell(''), '—')
  assert.equal(cell(undefined), '—')
})

test('markdownTable: header, mandatory separator, then rows', () => {
  const table = markdownTable(['项目', '值'], [['轮次', '3 轮 12 步']])
  assert.equal(table, ['| 项目 | 值 |', '| --- | --- |', '| 轮次 | 3 轮 12 步 |'].join('\n'))
})

test('markdownTable: nothing to draw is an empty string, not an empty table', () => {
  assert.equal(markdownTable(['项目', '值'], []), '')
  assert.equal(markdownTable([], [['a', 'b']]), '')
  assert.equal(markdownTable(['项目'], [null, undefined, 'x']), '')
})

test('changesSeqOfTurn: the newest announcement at or after the turn start', () => {
  const events = [
    { seq: 1, type: 'turn/start' },
    { seq: 4, type: 'workspace/changes', data: { turn: 1 } },
    { seq: 6, type: 'turn/end' },
    { seq: 9, type: 'turn/start' },
    { seq: 12, type: 'workspace/changes', data: { turn: 2 } },
    { seq: 13, type: 'workspace/changes', data: { turn: 2 } },
    { seq: 14, type: 'turn/end' },
  ]
  // A turn can announce twice (late tool results), so the newest one wins.
  assert.equal(changesSeqOfTurn(events, 9), 13)
  assert.equal(changesSeqOfTurn(events, 0), 13)
  assert.equal(changesSeqOfTurn(events, 14), undefined)
  assert.equal(changesSeqOfTurn(undefined, 0), undefined)
})

test('fileRows: totals first, then one row per file', () => {
  const summary = {
    turn: 4,
    total: 2,
    added: 128,
    deleted: 12,
    files: [
      { path: 'D:\\p\\index.js', display: 'index.js', added: 96, deleted: 8 },
      { path: 'D:\\p\\tests\\a.test.js', display: 'tests/a.test.js', added: 32, deleted: 4 },
    ],
  }
  assert.deepEqual(fileRows(summary), [
    ['文件', '2 个 +128 −12'],
    ['index.js', '+96 −8'],
    ['tests/a.test.js', '+32 −4'],
  ])
})

test('fileRows: binary and oversized files carry no counts', () => {
  const summary = {
    total: 3,
    added: 1,
    deleted: 1,
    files: [
      { display: 'logo.png', added: 0, deleted: 0, binary: true },
      { display: 'huge.json', added: 0, deleted: 0, oversized: true },
      { display: 'ok.js', added: 1, deleted: 1 },
    ],
  }
  assert.deepEqual(fileRows(summary), [
    ['文件', '3 个 +1 −1'],
    ['logo.png', '二进制'],
    ['huge.json', '超限'],
    ['ok.js', '+1 −1'],
  ])
})

test('fileRows: the list is capped while the total stays honest', () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ display: `f${i}.js`, added: 1, deleted: 0 }))
  const rows = fileRows({ files, total: 12, added: 12, deleted: 0 }, { limit: 8 })
  assert.equal(rows.length, 1 + 8 + 1)
  assert.deepEqual(rows.at(-1), ['…还有 4 个', '—'])
})

test('fileRows: no changes means no rows at all', () => {
  assert.deepEqual(fileRows(undefined), [])
  assert.deepEqual(fileRows({ files: [], total: 0, added: 0, deleted: 0 }), [])
})

test('fileRows: a summary larger than the listed files still reports the total', () => {
  const rows = fileRows({
    total: 600,
    added: 5,
    deleted: 5,
    files: [{ display: 'a.js', added: 5, deleted: 5 }],
  })
  assert.deepEqual(rows, [['文件', '600 个 +5 −5'], ['a.js', '+5 −5'], ['…还有 599 个', '—']])
})
