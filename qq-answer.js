/**
 * Pure helpers for answering DSH decisions from a QQ reply.
 *
 * Kept free of Cordis, QQ transport and timers so the routing rules can be
 * tested without a live host: which parked decision a message targets, and how
 * the reply text maps onto the DSH answer vocabulary.
 *
 * DSH shapes these helpers must honour:
 *   approval outcome      'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
 *   question answer       { id, selected: string[], custom?: string }
 *   question (service)    { id, question, header?, options?: [{label, description?}], multiSelect? }
 */

const ALLOW_WORDS =
  /^(ok|okay|yes|y|allow|approve|允许一次|允许|同意|批准|通过|可以|好|好的)$/i
const DENY_WORDS = /^(no|n|nope|deny|reject|不允许|拒绝|驳回|不同意|不行|否)$/i

/** @returns {'allowed-once' | 'rejected' | undefined} */
export function parseApprovalOutcome(text) {
  const value = String(text ?? '').trim()
  if (!value) return undefined
  if (ALLOW_WORDS.test(value)) return 'allowed-once'
  if (DENY_WORDS.test(value)) return 'rejected'
  return undefined
}

/**
 * Quoted-message index of an inbound message.
 *
 * QQ reports it two ways: `message_scene.ext` entries (`ref_msg_idx=…`, older
 * `refMsgIdx:…`), or the first `msg_elements[0].msg_idx`. The value matches the
 * `ext_info.ref_idx` returned when we sent the card.
 *
 * @param {any} rawMessage the inbound `d` payload
 * @returns {string | undefined}
 */
export function extractRefIdx(rawMessage) {
  const data = rawMessage && typeof rawMessage === 'object' ? rawMessage : {}
  const ext = Array.isArray(data.message_scene?.ext) ? data.message_scene.ext : []
  for (const item of ext) {
    if (typeof item !== 'string') continue
    const match = item.match(/^(?:ref_msg_idx|refMsgIdx)[=:](.+)$/)
    if (match) return match[1]
  }
  const first = Array.isArray(data.msg_elements) ? data.msg_elements[0] : undefined
  if (first && typeof first.msg_idx === 'string' && first.msg_idx) return first.msg_idx
  return undefined
}

/**
 * `其他：…` is the card's free-text door: the chip inserts the prefix and the
 * user finishes the sentence, so everything after it is the custom answer. It
 * can sit behind selected labels, because multiSelect lets both coexist.
 */
const CUSTOM_MARK = /(?:^|[,，\s]+)(?:其他|自定义|custom)\s*[:：]\s*/i

/**
 * Match one answer token against the offered options.
 *
 * The card mounts each option's own label as its chip, and `cmd-enter` displays
 * exactly what it sends, so a label comes back verbatim. Numbers stay supported
 * because a user can still type them.
 */
function matchOption(options, token) {
  const index = Number(token)
  if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1]
  const needle = String(token ?? '').trim().toLowerCase()
  if (!needle) return undefined
  return options.find((option) => String(option?.label ?? '').trim().toLowerCase() === needle)
}

/**
 * Map a reply onto DSH's structured question answer.
 *
 * Accepts a 1-based index (`1`, `1,3` for multiSelect, Chinese commas too) or an
 * option label exactly as the chip sent it. Anything unrecognised is a free-form
 * answer — never a guess, because silently picking an option answers a question
 * the user did not answer.
 *
 * DSH's own rules are preserved: a `custom` text replaces the selection on a
 * single-choice question, and supplements it on a multiSelect.
 *
 * @param {{ id: string, options?: Array<{ label: string }>, multiSelect?: boolean }} question
 * @param {string} text
 */
export function parseQuestionAnswer(question, text) {
  const raw = String(text ?? '').trim()
  const id = question?.id
  const options = Array.isArray(question?.options) ? question.options : []
  if (!raw) return { id, selected: [] }
  if (options.length === 0) return { id, selected: [], custom: raw }

  let body = raw
  let custom
  const mark = CUSTOM_MARK.exec(raw)
  if (mark) {
    body = raw.slice(0, mark.index)
    custom = raw.slice(mark.index + mark[0].length).trim() || undefined
  }

  const chosen = []
  if (body) {
    const tokens = body.split(/[,，\s]+/).map((token) => token.trim()).filter(Boolean)
    for (const token of tokens) {
      const option = matchOption(options, token)
      if (!option) return { id, selected: [], custom: raw }
      chosen.push(option.label)
    }
  }

  if (chosen.length === 0) {
    return custom === undefined ? { id, selected: [] } : { id, selected: [], custom }
  }
  const unique = [...new Set(chosen)]
  const selected = question?.multiSelect ? unique : [unique[0]]
  if (custom === undefined) return { id, selected }
  // Single choice: the free text replaces the pick. Multi: it rides along.
  return question?.multiSelect ? { id, selected, custom } : { id, selected: [], custom }
}

function findByRef(entries, refIdx) {
  if (!refIdx) return undefined
  for (const entry of entries) {
    if (Array.isArray(entry.refIds) && entry.refIds.includes(refIdx)) return entry
  }
  return undefined
}

function findByAlias(entries, alias) {
  for (const entry of entries) {
    if (entry.alias === alias) return entry
  }
  return undefined
}

/**
 * Decide which parked decision one inbound message answers.
 *
 * Precedence: the quoted card, then an explicit `#alias` prefix, then the only
 * pending decision. Ambiguity is never guessed.
 *
 * @param {object} input
 * @param {Iterable<any>} input.approvals parked approvals, each `{ alias, refIds }`
 * @param {Iterable<any>} input.questions parked questions, each `{ alias, refIds }`
 * @param {string} [input.refIdx] quoted card index from {@link extractRefIdx}
 * @param {string} input.text reply text
 * @returns {{ kind: 'approval' | 'question', entry: any, payload: string } | undefined}
 */
export function selectPendingDecision({ approvals, questions, refIdx, text }) {
  const approvalsList = [...approvals]
  const questionsList = [...questions]
  const value = String(text ?? '').trim()
  if (!value) return undefined

  const prefixed = value.match(/^#(\d+)\s*([\s\S]*)$/)
  const payload = prefixed ? prefixed[2].trim() : value

  let kind
  let entry
  if (refIdx) {
    entry = findByRef(approvalsList, refIdx)
    if (entry) kind = 'approval'
    if (!entry) {
      entry = findByRef(questionsList, refIdx)
      if (entry) kind = 'question'
    }
  }
  if (!entry && prefixed) {
    entry = findByAlias(approvalsList, Number(prefixed[1]))
    if (entry) kind = 'approval'
    if (!entry) {
      entry = findByAlias(questionsList, Number(prefixed[1]))
      if (entry) kind = 'question'
    }
  }
  if (!entry && !prefixed) {
    const total = approvalsList.length + questionsList.length
    if (total === 1) {
      if (approvalsList.length === 1) {
        kind = 'approval'
        entry = approvalsList[0]
      } else {
        kind = 'question'
        entry = questionsList[0]
      }
    }
  }
  if (!entry) return undefined
  if (!payload) return undefined
  return { kind, entry, payload }
}

/**
 * A bare command line, as QQ's 指令面板 inserts it.
 *
 * The platform stores a `type=command` item name without the leading slash and
 * drops that exact text into the input box, so every panel tap arrives as
 * `s 3` instead of `/s 3`. Only a whole-message match is accepted — never a
 * prefix — so ordinary chat text can never be mistaken for a command.
 */
const BARE_COMMAND = /^(s|show|ls|list|status|off|help)(?:\s+(\d+))?$/i

/**
 * Parse a `/command` line from QQ.
 *
 * `/s 3` (also `/show 3`, and the slashless `s 3` a 指令面板 entry produces) is
 * what the panel inserts, so the panel can be the navigation surface without
 * needing any push message.
 *
 * @param {string} text
 * @returns {{ command: 'ls' | 'status' | 'off' | 's' | 'kbtest' | 'txttest' | 'chipprobe' | 'answer' | 'help', alias?: number, value?: string } | undefined}
 */
export function parseCommand(text) {
  const value = String(text ?? '').trim()
  if (!value) return undefined
  let body
  if (value.startsWith('/')) {
    body = value.slice(1)
  } else if (BARE_COMMAND.test(value)) {
    body = value
  } else {
    return undefined
  }
  const [rawName, ...rest] = body.split(/\s+/)
  const name = rawName.toLowerCase()
  const argument = rest.join(' ').trim()
  if (name === 'ls' || name === 'list') return { command: 'ls' }
  if (name === 'status') return { command: 'status' }
  if (name === 'kbtest') return { command: 'kbtest' }
  if (name === 'txttest') return { command: 'txttest' }
  if (name === 'chipprobe') return { command: 'chipprobe' }
  // `/a3 1` is what a card's 文本交互 chip sends: one tap, one message, no
  // callback endpoint. The alias pins the session so it cannot be guessed
  // wrong; the value is whatever the card put there (`1`, `ok`, `no`).
  const targeted = /^a(\d+)$/.exec(name)
  if (targeted) return { command: 'answer', alias: Number(targeted[1]), value: argument }
  if (name === 'show' || name === 's') {
    const alias = Number(argument)
    return { command: 's', alias: Number.isInteger(alias) && alias > 0 ? alias : undefined }
  }
  if (name === 'off') {
    const alias = argument ? Number(argument) : undefined
    return { command: 'off', alias: Number.isInteger(alias) ? alias : undefined }
  }
  return { command: 'help' }
}

/**
 * Full inbound routing decision.
 *
 * Order: slash command, parked decision, quoted notification card, `#alias`
 * session message, then nothing (the caller answers with help). The session
 * branch is what P4 adds on top of the P2 answer routing.
 *
 * @param {object} input
 * @param {Iterable<any>} input.approvals
 * @param {Iterable<any>} input.questions
 * @param {Map<string, string>} [input.sentCards] ref_idx -> sessionId for notification cards we sent
 * @param {Map<number, string>} [input.aliasSessions] alias -> sessionId
 * @param {string} [input.refIdx]
 * @param {string} input.text
 * @returns {
 *   | { kind: 'command', command: string, alias?: number }
 *   | { kind: 'decision', decision: { kind: 'approval' | 'question', entry: any, payload: string } }
 *   | { kind: 'session', sessionId: string, payload: string }
 *   | { kind: 'error', message: string }
 *   | undefined
 * }
 */
export function selectInboundRoute({ approvals, questions, sentCards, aliasSessions, refIdx, text }) {
  const value = String(text ?? '').trim()
  if (!value) return undefined

  const command = parseCommand(value)
  if (command) return { kind: 'command', ...command }

  const decision = selectPendingDecision({ approvals, questions, refIdx, text: value })
  if (decision) return { kind: 'decision', decision }

  if (refIdx && sentCards && sentCards.has(refIdx)) {
    return { kind: 'session', sessionId: sentCards.get(refIdx), payload: value }
  }

  const prefixed = value.match(/^#(\d+)\s*([\s\S]*)$/)
  if (prefixed) {
    const alias = Number(prefixed[1])
    const payload = prefixed[2].trim()
    const sessionId = aliasSessions ? aliasSessions.get(alias) : undefined
    if (!sessionId) return { kind: 'error', message: `没有 #${alias} 这个会话，发送 /ls 查看` }
    if (!payload) return { kind: 'error', message: `请在 #${alias} 后面写上要发送的内容` }
    return { kind: 'session', sessionId, payload }
  }

  return undefined
}
