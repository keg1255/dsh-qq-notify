/**
 * dsh-qq-notify — agent-callable `notify` tool.
 *
 * Registered on the tools registry so the agent can push a QQ message itself
 * ("加分项"). Shares the exact send chain with the event notifications
 * (relay POST → ledger) and is rate-limited by a sliding window.
 *
 * defineTool is imported dynamically from the host's dsh-tools so the plugin
 * keeps zero runtime dependencies and still loads when that import fails; the
 * fallback definition is the exact compiled JSON-schema shape defineTool
 * itself produces, so the runtime validates it identically.
 */
import { ensureNonEmpty, buildToolBody } from './message.mjs'

const TOOL_NAME = 'notify'
const TOOL_DESCRIPTION =
  'Send a QQ push notification to the user through the dsh-qq-notify plugin. ' +
  'Use when the user asked to be notified of something, or for urgent out-of-band updates. ' +
  'The message is rendered as markdown on QQ. Rate-limited; failures are reported in the result.'

function buildRawDefinition (execute) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    // Exact compiled form of parameterSchemaSpecToJsonSchema over the
    // { message (required), title } property spec.
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Notification body in markdown. Keep it self-contained; this is all the user sees.',
        },
        title: {
          type: 'string',
          description: 'Optional short bold headline shown above the message.',
        },
      },
      required: ['message'],
    },
    output: {
      // Compiled JSON-schema form (valueSchemaSpecToJsonSchema output):
      // required lives at the object level; the author-form `required: true`
      // inside a property only exists pre-compilation inside defineTool.
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean' },
          detail: { type: 'string' },
        },
        required: ['delivered'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered === true
          ? 'QQ notification delivered.'
          : `QQ notification failed: ${value.detail ?? 'unknown error'}`,
      }],
    },
    execute,
    presentCall: (args) => ({
      card: 'generic',
      title: 'Send QQ notification',
      kind: 'other',
      rawInput: args,
    }),
  }
}

/**
 * Create the tool definition.
 * @param push - async `(content) => sendResult` bound to the dispatcher
 * @param limiter - SlidingWindowLimiter instance
 * @returns registry-ready definition (defineTool-wrapped when available)
 */
export async function createNotifyTool (push, limiter) {
  const execute = async (args) => {
    const admission = limiter.tryAcquire()
    if (!admission.ok) {
      const seconds = Math.max(1, Math.ceil((admission.retryAfterMs ?? 60_000) / 1000))
      return { delivered: false, detail: `rate limited; retry in ${seconds}s` }
    }
    const content = ensureNonEmpty(buildToolBody(args?.message, args?.title), TOOL_NAME)
    const result = await push(content)
    return result.ok === true
      ? { delivered: true }
      : { delivered: false, detail: result.error ?? 'unknown error' }
  }
  try {
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    if (typeof defineTool === 'function') return defineTool(buildRawDefinition(execute))
  } catch {
    // Not resolvable outside the host loader (tests, isolated processes):
    // the raw definition below has the identical compiled shape.
  }
  return buildRawDefinition(execute)
}
