/**
 * Turning Host facts into the completion card's table rows.
 *
 * "Which files did this turn touch" is already computed by DSH: the
 * `@deepseek-ai/dsh-workspace-changes` recorder appends one log-only
 * `workspace/changes` event per turn and keeps the summary on the Host, behind
 * `ctx.workspaceChanges.summary(sessionId, seq)` where `seq` is that event's
 * sequence number. The plugin only looks up the coordinate and renders it —
 * re-deriving the list from tool calls would disagree with DSH itself.
 *
 * Everything here is pure so the table shape can be tested without a Host.
 */

/** A full path list would swamp a phone screen; the total is still reported. */
export const FILE_ROW_LIMIT = 8

/**
 * Escape one table cell.
 *
 * A raw `|` would be read as a column separator and split the cell in two, and
 * a newline ends the row. Both are replaced rather than dropped so the value
 * stays recognisable.
 *
 * @param {unknown} value
 */
export function cell(value) {
  const text = String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '｜')
    .trim()
  return text || '—'
}

/**
 * A markdown table, or an empty string when there is nothing to draw.
 *
 * The separator row is mandatory: without it QQ renders the pipes as plain
 * text instead of a table.
 *
 * @param {string[]} head column labels
 * @param {Array<Array<unknown>>} rows
 */
export function markdownTable(head, rows) {
  const columns = Array.isArray(head) ? head : []
  if (columns.length === 0) return ''
  const body = (Array.isArray(rows) ? rows : []).filter(
    (row) => Array.isArray(row) && row.length > 0,
  )
  if (body.length === 0) return ''
  const line = (cells) => `| ${cells.map(cell).join(' | ')} |`
  const separator = `|${columns.map(() => ' --- ').join('|')}|`
  return [line(columns), separator, ...body.map(line)].join('\n')
}

/**
 * Sequence number of the `workspace/changes` event this turn announced.
 *
 * The recorder appends it at turn stopping (and again at turn end when a tool
 * result landed late), so the newest one at or after the turn start is the
 * coordinate `summary()` expects — not the `turn/end` sequence.
 *
 * @param {Array<any>} events
 * @param {number} fromSeq first sequence number of the turn
 * @returns {number | undefined}
 */
export function changesSeqOfTurn(events, fromSeq = 0) {
  const floor = Number.isFinite(Number(fromSeq)) ? Number(fromSeq) : 0
  let found
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'workspace/changes') continue
    const seq = Number(event.seq)
    if (!Number.isFinite(seq) || seq < floor) continue
    if (found === undefined || seq > found) found = seq
  }
  return found
}

/**
 * `[label, value]` rows describing what the turn changed.
 *
 * `display` is the Host's own presentation path — relative inside the working
 * directory, `../` above it, `~` under the home directory — so the card needs
 * no path shortening of its own.
 *
 * @param {{ files?: Array<any>, total?: number, added?: number, deleted?: number }} summary
 * @param {{ limit?: number }} [options]
 * @returns {Array<[string, string]>}
 */
export function fileRows(summary, options = {}) {
  const files = Array.isArray(summary?.files) ? summary.files : []
  if (files.length === 0) return []

  const limit =
    Number.isInteger(options.limit) && options.limit > 0 ? options.limit : FILE_ROW_LIMIT
  const total = Number.isFinite(Number(summary?.total)) ? Number(summary.total) : files.length
  const added = Number(summary?.added) || 0
  const deleted = Number(summary?.deleted) || 0

  const rows = [['文件', `${total} 个 +${added} −${deleted}`]]
  const shown = files.slice(0, limit)
  for (const file of shown) {
    const name = String(file?.display || file?.path || '').trim()
    if (!name) continue
    rows.push([name, fileValue(file)])
  }
  const hidden = total - shown.length
  if (hidden > 0) rows.push([`…还有 ${hidden} 个`, '—'])
  return rows
}

function fileValue(file) {
  if (file?.binary) return '二进制'
  if (file?.oversized) return '超限'
  const added = Number(file?.added) || 0
  const deleted = Number(file?.deleted) || 0
  return `+${added} −${deleted}`
}
