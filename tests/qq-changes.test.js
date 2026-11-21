import assert from 'node:assert/strict'
import test from 'node:test'

import { cell, changesSeqOfTurn, fileTable, markdownTable } from '../qq-changes.js'

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

test('fileTable: a header line plus one row per file', () => {
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
  assert.deepEqual(fileTable(summary), {
    label: '2 个文件 +128 −12',
    rows: [
      ['**index.js**', '96', '8'],
      ['tests/**a.test.js**', '32', '4'],
    ],
  })
})

test('fileTable: paths are the Host display form, absolute ones included', () => {
  // A file outside the session's working directory keeps its absolute path —
  // that difference is how the reader sees it is not part of the workspace.
  const table = fileTable({
    total: 1,
    added: 1,
    deleted: 0,
    files: [{ display: 'D:/other/repo/index.js', added: 1, deleted: 0 }],
  })
  assert.deepEqual(table.rows, [['D:/other/repo/**index.js**', '1', '0']])
})

test('fileTable: binary and oversized files carry no counts', () => {
  const table = fileTable({
    total: 3,
    added: 1,
    deleted: 1,
    files: [
      { display: 'logo.png', added: 0, deleted: 0, binary: true },
      { display: 'huge.json', added: 0, deleted: 0, oversized: true },
      { display: 'ok.js', added: 1, deleted: 1 },
    ],
  })
  assert.deepEqual(table.rows, [
    ['**logo.png**', '二进制', '—'],
    ['**huge.json**', '超限', '—'],
    ['**ok.js**', '1', '1'],
  ])
})

test('fileTable: the list is capped while the total stays honest', () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ display: `f${i}.js`, added: 1, deleted: 0 }))
  const table = fileTable({ files, total: 12, added: 12, deleted: 0 }, { limit: 8 })
  assert.equal(table.label, '12 个文件 +12 −0')
  assert.equal(table.rows.length, 8 + 1)
  assert.deepEqual(table.rows.at(-1), ['…还有 4 个', '—', '—'])
})

test('fileTable: no changes means no block at all', () => {
  assert.equal(fileTable(undefined), undefined)
  assert.equal(fileTable({ files: [], total: 0, added: 0, deleted: 0 }), undefined)
})

test('fileTable: a summary larger than the listed files still reports the total', () => {
  const table = fileTable({
    total: 600,
    added: 5,
    deleted: 5,
    files: [{ display: 'a.js', added: 5, deleted: 5 }],
  })
  assert.deepEqual(table, {
    label: '600 个文件 +5 −5',
    rows: [
      ['**a.js**', '5', '5'],
      ['…还有 599 个', '—', '—'],
    ],
  })
})
