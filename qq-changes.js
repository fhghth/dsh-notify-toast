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
 * The file block for the completion card: a header line plus table rows.
 *
 * A table earns its borders here because these rows are homogeneous — one path
 * against two counts — and the numbers line up. The key/value facts above stay
 * plain lines: a grid for six one-off rows is noise, not structure.
 *
 * `display` is the Host's own presentation path, kept verbatim: relative inside
 * the working directory, absolute outside it. The difference is the point — an
 * absolute path is how the reader sees that the file lives elsewhere.
 *
 * @param {{ files?: Array<any>, total?: number, added?: number, deleted?: number }} summary
 * @param {{ limit?: number }} [options]
 * @returns {{ label: string, rows: Array<string[]> } | undefined}
 */
export function fileTable(summary, options = {}) {
  const files = Array.isArray(summary?.files) ? summary.files : []
  if (files.length === 0) return undefined

  const limit =
    Number.isInteger(options.limit) && options.limit > 0 ? options.limit : FILE_ROW_LIMIT
  const total = Number.isFinite(Number(summary?.total)) ? Number(summary.total) : files.length
  const added = Number(summary?.added) || 0
  const deleted = Number(summary?.deleted) || 0

  const shown = files.slice(0, limit)
  const rows = []
  for (const file of shown) {
    const name = String(file?.display || file?.path || '').trim()
    if (!name) continue
    if (file?.binary) rows.push([emphasize(name), '二进制', '—'])
    else if (file?.oversized) rows.push([emphasize(name), '超限', '—'])
    else rows.push([emphasize(name), String(Number(file?.added) || 0), String(Number(file?.deleted) || 0)])
  }
  const hidden = total - shown.length
  if (hidden > 0) rows.push([`…还有 ${hidden} 个`, '—', '—'])
  if (rows.length === 0) return undefined
  return { label: `${total} 个文件 +${added} −${deleted}`, rows }
}

/**
 * Bold the file name and leave the directory plain.
 *
 * The directory is context; the file is what the reader is scanning for. Bold
 * survives inside a table cell because the closing `**` is followed by the
 * cell separator, which counts as whitespace.
 *
 * @param {string} path
 */
function emphasize(path) {
  const slash = path.lastIndexOf('/')
  if (slash < 0 || slash === path.length - 1) return `**${path}**`
  return `${path.slice(0, slash + 1)}**${path.slice(slash + 1)}**`
}
