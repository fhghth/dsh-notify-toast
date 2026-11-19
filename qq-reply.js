/**
 * Pulling the assistant's own words out of a session log.
 *
 * The host already has the parsed events (`session.snapshotEvents()`), so the
 * output is available synchronously at `turn/end` — no log parsing, no second
 * source of truth.
 *
 * Event shape (verified against a live session log):
 *
 *   { type: 'assistant/message', seq, data: { turn, message: { role, content: [
 *       { type: 'reasoning', text: '…' },   // never forwarded
 *       { type: 'text',      text: '…' },   // this is what we want
 *   ] } } }
 *
 * Pure and transport-free so the extraction rules can be tested offline.
 */

/**
 * Sequence number of the turn that a `turn/end` at `endSeq` closes.
 *
 * Walks back to the nearest `turn/start`; returns 0 when the log has none in
 * the visible window, which simply means "from the beginning".
 *
 * @param {Array<{ seq: number, type: string }>} events
 * @param {number} endSeq
 */
export function turnStartSeq(events, endSeq) {
  let start = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue
    const seq = Number(event.seq)
    if (!Number.isFinite(seq) || seq > endSeq) continue
    if (event.type === 'turn/start') start = seq
  }
  return start
}

/**
 * Concatenated assistant text between two sequence numbers.
 *
 * Only `text` blocks are kept: `reasoning` is the model's private scratchpad
 * and must never leave the machine.
 *
 * @param {Array<any>} events
 * @param {{ fromSeq?: number, toSeq?: number }} [range]
 */
export function collectAssistantText(events, { fromSeq = 0, toSeq = Number.POSITIVE_INFINITY } = {}) {
  const parts = []
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'assistant/message') continue
    const seq = Number(event.seq)
    if (!Number.isFinite(seq) || seq < fromSeq || seq > toSeq) continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || block.type !== 'text') continue
      if (typeof block.text !== 'string') continue
      const text = block.text.trim()
      if (text) parts.push(text)
    }
  }
  return parts.join('\n\n')
}

/**
 * The body for a turn that has just ended.
 *
 * @param {Array<any>} events
 * @param {number} endSeq the `turn/end` sequence number
 */
export function turnReplyText(events, endSeq) {
  const fromSeq = turnStartSeq(events, endSeq)
  return collectAssistantText(events, { fromSeq, toSeq: endSeq })
}

/**
 * The body to attach to a decision card (approval / question).
 *
 * A decision is asked *during* a turn, so there is no finished reply — but the
 * assistant's reasoning so far is exactly what makes the request judgeable.
 * Everything from the current turn up to this point is included.
 *
 * @param {Array<any>} events
 * @param {number} [beforeSeq] defaults to the newest event
 */
export function pendingReplyText(events, beforeSeq) {
  const list = Array.isArray(events) ? events : []
  const end = Number.isFinite(Number(beforeSeq))
    ? Number(beforeSeq)
    : Number(list.at(-1)?.seq ?? 0)
  const fromSeq = turnStartSeq(list, end)
  return collectAssistantText(list, { fromSeq, toSeq: end })
}

/**
 * Roll the durable log up into the numbers the DSH status bar shows.
 *
 * Counts come from the log itself, so they need no service. Token figures are
 * summed from each `assistant/message`'s provider-reported `usage`:
 *
 *   usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
 *
 * where `inputTokens` is already the *uncached* part, so the cache hit rate is
 * `cacheRead / (cacheRead + input)`.
 *
 * @param {Array<any>} events
 * @param {{ fromSeq?: number, toSeq?: number }} [range]
 */
export function summarizeUsage(events, { fromSeq = 0, toSeq = Number.POSITIVE_INFINITY } = {}) {
  const summary = {
    turns: 0,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    /** 0..1, or undefined when no request reported a prompt size. */
    cacheHit: undefined,
  }
  for (const event of Array.isArray(events) ? events : []) {
    if (!event) continue
    const seq = Number(event.seq)
    if (!Number.isFinite(seq) || seq < fromSeq || seq > toSeq) continue
    if (event.type === 'turn/end') summary.turns += 1
    else if (event.type === 'step/end') summary.steps += 1

    const usage = event.type === 'assistant/message' ? event.data?.usage : undefined
    if (!usage || typeof usage !== 'object') continue
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    const cacheRead = Number(usage.cacheReadTokens) || 0
    const cacheWrite = Number(usage.cacheWriteTokens) || 0
    summary.inputTokens += input
    summary.outputTokens += output
    summary.cacheReadTokens += cacheRead
    summary.cacheWriteTokens += cacheWrite
    summary.totalTokens += Number(usage.totalTokens) || input + output + cacheRead + cacheWrite
  }
  const prompt = summary.cacheReadTokens + summary.inputTokens
  if (prompt > 0) summary.cacheHit = summary.cacheReadTokens / prompt
  return summary
}

/**
 * Last-resort truncation, used only after the platform rejects a message as
 * too long. Head and tail are kept because the conclusion usually lives at the
 * end while the intent lives at the start.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {{ text: string, truncated: boolean }}
 */
export function fitMessage(text, limit) {
  const value = String(text ?? '')
  const cap = Number(limit)
  if (!(cap > 0) || value.length <= cap) return { text: value, truncated: false }
  const head = Math.floor(cap * 0.55)
  const tail = Math.max(0, cap - head)
  const omitted = value.length - cap
  return {
    text: `${value.slice(0, head)}\n\n……（已省略约 ${omitted} 字，完整内容在 DSH 中查看）……\n\n${value.slice(-tail)}`,
    truncated: true,
  }
}
