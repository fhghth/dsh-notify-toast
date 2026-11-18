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

const ALLOW_WORDS = /^(ok|okay|yes|y|allow|允许|同意|批准|通过|可以|好|好的)$/i
const DENY_WORDS = /^(no|n|nope|deny|reject|拒绝|驳回|不同意|不行|否)$/i

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
 * Map a reply onto DSH's structured question answer.
 *
 * Numbers select offered options (`1`, `1,3` for multiSelect, Chinese commas
 * accepted); anything else is a free-form answer. Out-of-range numbers fall
 * back to free text rather than silently choosing the wrong option.
 *
 * @param {{ id: string, options?: Array<{ label: string }>, multiSelect?: boolean }} question
 * @param {string} text
 */
export function parseQuestionAnswer(question, text) {
  const value = String(text ?? '').trim()
  const id = question?.id
  const options = Array.isArray(question?.options) ? question.options : []
  if (options.length === 0) return { id, selected: [], custom: value }

  const parts = value.split(/[,，\s]+/).filter(Boolean)
  const chosen = []
  let numeric = parts.length > 0
  for (const part of parts) {
    const index = Number(part)
    if (!Number.isInteger(index) || index < 1 || index > options.length) {
      numeric = false
      break
    }
    chosen.push(options[index - 1].label)
  }
  if (numeric && chosen.length > 0) {
    return { id, selected: question?.multiSelect ? chosen : [chosen[0]] }
  }
  return { id, selected: [], custom: value }
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
