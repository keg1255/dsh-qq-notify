/**
 * dsh-qq-notify — QQ relay message assembly.
 *
 * The relay (notice.inu1255.cn/qq/send) rejects empty `content` with HTTP 500
 * `{"ok":false,"error":"content is required"}` and silently drops such
 * notifications, so every builder here guarantees a non-empty string via
 * `ensureNonEmpty`. Markdown is rendered by the relay.
 */

/** When nothing else can be produced, send this instead of an empty body. */
const PLACEHOLDER = '(通知内容为空)'

/** Clamp a string to `max` characters, appending an ellipsis when truncated. */
export function clip (text, max) {
  const s = typeof text === 'string' ? text : ''
  if (!Number.isFinite(max) || max <= 0) return s
  if (s.length <= max) return s
  const cut = Math.max(0, Math.floor(max))
  return cut <= 1 ? '…' : s.slice(0, cut - 1) + '…'
}

/**
 * Guarantee a non-empty content string: prefer `body`, fall back to `title`,
 * then to a fixed placeholder. This is the last line of defense before POST —
 * the relay 500s on empty content and the notification would be lost.
 */
export function ensureNonEmpty (body, title) {
  if (typeof body === 'string' && body.trim() !== '') return body
  if (typeof title === 'string' && title.trim() !== '') return title
  return PLACEHOLDER
}

/** One-line collapse of arbitrary whitespace for headline use. */
function oneLine (text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** Map a `turn/end` reason kind to the emoji + headline of the notification. */
export function turnEndKindLabel (kind) {
  switch (kind) {
    case 'completed': return { emoji: '✅', label: '任务完成' }
    case 'error': return { emoji: '❌', label: '任务出错' }
    case 'blocked': return { emoji: '⛔', label: '任务受阻' }
    case 'aborted': return { emoji: '⏹', label: '已中止' }
    case 'max-tokens': return { emoji: '🔢', label: '达到 token 上限' }
    case 'interrupted': return { emoji: '⏸', label: '已被打断' }
    default: return undefined // unknown kinds are silently ignored by the listener
  }
}

/**
 * Build the approval/asked notification body.
 * @param data - `{ id, toolName, callId?, reason? }`
 */
export function buildApprovalBody (data) {
  const tool = oneLine(data?.toolName) || '未知工具'
  const reason = oneLine(data?.reason)
  const lines = ['🔐 **需要你批准**']
  lines.push(`- 工具：\`${tool}\``)
  if (reason !== '') lines.push(`- 原因：${reason}`)
  return lines.join('\n')
}

/**
 * Build the ask_user (`user-questions/request`) notification body.
 * @param questions - `[{ id, question, header?, options? }]`
 */
export function buildAskUserBody (questions) {
  const list = Array.isArray(questions) ? questions : []
  const lines = ['💬 **Agent 有问题要问你**']
  for (const q of list) {
    const header = oneLine(q?.header)
    const text = oneLine(q?.question)
    if (header !== '') lines.push(`- [${header}] ${text}`)
    else if (text !== '') lines.push(`- ${text}`)
  }
  if (lines.length === 1) lines.push('- (问题内容缺失)')
  return lines.join('\n')
}

/**
 * Build the agent/error notification body.
 * @param payload - `{ agent?, turn?, step?, error? }`
 */
export function buildAgentErrorBody (payload) {
  const error = payload?.error
  const message = oneLine(error?.message ?? error)
  const turn = Number.isFinite(payload?.turn) ? payload.turn : undefined
  const lines = ['🔥 **Agent 内部错误**']
  if (turn !== undefined) lines.push(`- 回合：turn ${turn}`)
  if (typeof error?.code === 'string' && error.code !== '') lines.push(`- 错误码：\`${error.code}\``)
  lines.push(`- 错误：${message !== '' ? clip(message, 300) : '(无错误信息)'}`)
  return lines.join('\n')
}

/**
 * Build the `turn/end` notification body, including the last assistant excerpt.
 * Returns `undefined` for unknown kinds so the listener can skip silently.
 * @param data - `{ turn, reason: { kind } }`
 * @param excerpt - last assistant text (already clipped by the caller)
 */
export function buildTurnEndBody (data, excerpt) {
  const kind = data?.reason?.kind
  const head = turnEndKindLabel(kind)
  if (head === undefined) return undefined
  const lines = [`${head.emoji} **${head.label}**`]
  if (Number.isFinite(data?.turn)) lines.push(`- 回合：turn ${data.turn}`)
  if (kind === 'error') {
    const error = data?.reason?.error ?? {}
    const message = oneLine(error.message)
    if (typeof error.code === 'string' && error.code !== '') lines.push(`- 错误码：\`${error.code}\``)
    if (message !== '') lines.push(`- 错误：${clip(message, 300)}`)
    else if (typeof error.code !== 'string') lines.push('- 错误：(无错误信息)')
  }
  if (kind === 'aborted') {
    const cause = data?.reason?.reason
    const causeText = oneLine(typeof cause === 'object' && cause !== null ? cause.kind : cause)
    if (causeText !== '') lines.push(`- 中止原因：${causeText}`)
  }
  if (kind === 'blocked') lines.push('- 任务在等待你的输入（未完成，请回来看一眼）')
  const summary = typeof excerpt === 'string' ? excerpt.trim() : ''
  if (summary !== '') lines.push('', `> ${summary.replace(/\n/g, '\n> ')}`)
  return lines.join('\n')
}

/** Body for the agent-callable notify tool. */
export function buildToolBody (message, title) {
  const t = oneLine(title)
  const m = typeof message === 'string' ? message : ''
  return t !== '' ? `📨 **${t}**\n\n${m}` : `📨 ${m}`
}

/**
 * Extract the last assistant message's concatenated text from a session event
 * snapshot, scanning tail-first per the spec.
 * @param events - readonly array of session events (from session.snapshotEvents())
 * @param maxChars - clamp the joined text to this length
 * @returns joined text ('' when no assistant text exists); never null/undefined
 */
export function lastAssistantExcerpt (events, maxChars = 500) {
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') return clip(text, maxChars)
  }
  return ''
}

/** Build the JSON body POSTed to the relay. `content` is guaranteed non-empty. */
export function buildRelayPayload (openid, content) {
  const safe = ensureNonEmpty(content)
  const payload = { openid: typeof openid === 'string' ? openid : '', content: safe }
  if (payload.openid === '') delete payload.openid
  return payload
}
