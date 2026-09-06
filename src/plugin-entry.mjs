/**
 * dsh-qq-notify — plugin entry (cordis plugin, default export).
 *
 * Notifies via the QQ relay (notice.inu1255.cn/qq/send):
 *   - approval/asked        → instant "🔐 需要你批准"
 *   - user-questions/request → instant "💬 Agent 有问题要问你" (observer, next() passthrough)
 *   - turn/end (completed)  → debounced "✅ 任务完成" + assistant excerpt
 *   - turn/end (other kinds)→ instant "❌/⛔/⏹/…"
 *   - agent/error           → instant "🔥 Agent 内部错误"
 *
 * Hard rules (learned from the dsh-notifier postmortem, all re-verified on
 * 0.1.2-rc.1):
 *   - never throw at startup: config missing / channel down → warn and continue
 *   - session events have no `Session.events`; read `session.snapshotEvents()`
 *   - unknown turn/end kinds are silently ignored
 *   - every send has a non-empty `content` (relay 500s otherwise)
 *   - cordis logger is invisible under the web profile → console.error + JSONL
 *     ledger for everything that matters
 */
import { resolveConfig } from './config.mjs'
import { resolveStateDir, ledgerPathFor } from './state-dir.mjs'
import { createLedger } from './ledger.mjs'
import { sendToRelay } from './relay.mjs'
import { Dispatcher, TurnEndDebouncer } from './dispatch.mjs'
import { subscribeGlobal } from './host-events.mjs'
import {
  buildApprovalBody,
  buildAskUserBody,
  buildAgentErrorBody,
  buildTurnEndBody,
  lastAssistantExcerpt,
  workspaceNameOf,
} from './message.mjs'
import { SlidingWindowLimiter } from './rate-limit.mjs'
import { createNotifyTool } from './notify-tool.mjs'

const PLUGIN_ID = 'dsh-qq-notify'

/**
 * Required host services. Without declaring `tools`, cordis intercepts
 * `ctx.tools` access ("cannot get property without inject") and the notify
 * tool registration fails; the event subscriptions work regardless.
 */
export const inject = ['tools']

/**
 * Build a stable dedup key for a session event: `session.id:seq`. Events
 * without a usable id/seq yield null (no dedup) rather than colliding.
 */
function dedupKeyFor (session, event) {
  try {
    if (session?.id !== undefined && event?.seq !== undefined) return `${session.id}:${event.seq}`
  } catch {
    // fall through
  }
  return null
}

/**
 * Fire-and-forget async guard: logs rejections, never lets them escape into
 * the host's dispatch path.
 */
function safeAsync (promise, label) {
  Promise.resolve(promise).catch((error) => {
    console.error(`[${PLUGIN_ID}] ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/**
 * The cordis plugin. Signature matches what cordis-plugin-loader applies:
 * apply(ctx, config) from the package default export.
 */
export async function apply (ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  if (!config.enabled) {
    console.error(`[${PLUGIN_ID}] disabled by config; staying unloaded`)
    return
  }
  if (config.openid === '') {
    console.error(`[${PLUGIN_ID}] no openid configured; notifications would be dropped — staying passive`)
    return
  }

  const stateDir = resolveStateDir()
  const ledger = createLedger(ledgerPathFor(stateDir))
  const dispatcher = new Dispatcher(config, (payload) => sendToRelay(config, payload), ledger)
  const limiter = new SlidingWindowLimiter(config.tool.rateLimitPerMinute)
  const disposers = []

  // Completed-turn debounce: same-session consecutive completions within the
  // window collapse into one push of the LAST one. The body (with the final
  // assistant excerpt) is built at fire time from the newest pending event.
  const pendingCompleted = new Map() // sessionId -> { session, event }
  const completedDebouncer = new TurnEndDebouncer(config.debounceMs, (task) => task())

  /** Server + workspace context lines shown on every push. */
  const ctxInfoFor = (session) => ({
    serverName: config.serverName,
    workspaceName: workspaceNameOf(session),
  })

  console.error(`[${PLUGIN_ID}] loaded (url=${config.url}, ledger=${ledgerPathFor(stateDir) || 'disabled'}, debounce=${config.debounceMs}ms)`)

  // ---- session events (approval/asked + turn/end) ------------------------
  disposers.push(subscribeGlobal(ctx, 'session/event', (session, event) => {
    try {
      if (!session || !event) return
      const key = dedupKeyFor(session, event)

      if (event.type === 'approval/asked') {
        if (!config.events.approval) return
        safeAsync(
          dispatcher.push('approval', buildApprovalBody(event.data, ctxInfoFor(session)), key),
          'approval push',
        )
        return
      }

      if (event.type === 'turn/end') {
        if (!config.events.turnEnd) return
        const data = event.data
        const kind = data?.reason?.kind
        if (kind === 'completed') {
          pendingCompleted.set(session.id, { session, event })
          completedDebouncer.schedule(session.id, async () => {
            const latest = pendingCompleted.get(session.id)
            pendingCompleted.delete(session.id)
            if (!latest) return
            const excerpt = readAssistantExcerpt(latest.session, config.summaryMaxChars)
            const body = buildTurnEndBody(latest.event.data, excerpt, ctxInfoFor(latest.session))
            if (body === undefined || body === '') return
            await dispatcher.push('turn-end:completed', body, dedupKeyFor(latest.session, latest.event))
          })
          return
        }
        // Non-completed kinds push instantly; unknown kinds never arrive here
        // because buildTurnEndBody maps them to undefined and we skip first.
        if (kind === undefined || kind === null) return
        const body = buildTurnEndBody(data, '', ctxInfoFor(session))
        if (body === undefined) return // unknown kind: silently ignored
        // A turn-scoped provider failure surfaces as BOTH agent/error (bus)
        // and turn/end error (session). The turn/end push is the richer one —
        // cancel the pending delayed agent-error push for this session.
        if (kind === 'error') cancelPendingAgentError(session.id)
        safeAsync(
          dispatcher.push(`turn-end:${kind}`, body, key),
          'turn/end push',
        )
        return
      }

      // other session event types: silently ignored
    } catch (error) {
      console.error(`[${PLUGIN_ID}] session/event handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }))

  // ---- ask_user waterfall (agent question) -------------------------------
  if (config.events.askUser) {
    const disposer = subscribeGlobal(ctx, 'user-questions/request', (request, next) => {
      try {
        safeAsync(
          dispatcher.push(
            'ask-user',
            buildAskUserBody(request?.questions, { serverName: config.serverName, workspaceName: workspaceNameOf(request?.agent?.session) }),
            request?.questions?.[0]?.id !== undefined ? `ask:${request.questions[0].id}` : undefined,
          ),
          'ask-user push',
        )
      } catch (error) {
        console.error(`[${PLUGIN_ID}] ask-user handler failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      // Strict observer: always delegate to the real answerers.
      return next()
    })
    if (disposer) disposers.push(disposer)
  }

  // ---- agent/error bus event ---------------------------------------------
  // One provider failure surfaces twice in the host: agent/error on the bus,
  // then turn/end error on the session. The turn/end push carries the fuller
  // picture (turn number + excerpt-ready body), so the agent/error push waits
  // agentErrorDelayMs and is cancelled when the turn-end push fires for the
  // same session. Failures outside any turn still push after the delay.
  const pendingAgentErrors = new Map() // sessionKey -> { timer, push }
  function cancelPendingAgentError (sessionKey) {
    const pending = pendingAgentErrors.get(sessionKey)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingAgentErrors.delete(sessionKey)
  }
  if (config.events.agentError) {
    const disposer = subscribeGlobal(ctx, 'agent/error', (payload) => {
      try {
        const sessionKey = payload?.agent?.session?.id
        const body = buildAgentErrorBody(payload, { serverName: config.serverName, workspaceName: workspaceNameOf(payload?.agent?.session) })
        const timer = setTimeout(() => {
          if (sessionKey !== undefined && sessionKey !== null) pendingAgentErrors.delete(sessionKey)
          safeAsync(
            dispatcher.push('agent-error', body, null),
            'agent/error push',
          )
        }, config.agentErrorDelayMs)
        if (timer.unref) timer.unref()
        if (sessionKey !== undefined && sessionKey !== null) {
          const previous = pendingAgentErrors.get(sessionKey)
          if (previous) clearTimeout(previous.timer)
          pendingAgentErrors.set(sessionKey, { timer })
        }
      } catch (error) {
        console.error(`[${PLUGIN_ID}] agent/error handler failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    if (disposer) disposers.push(disposer)
    // dispose: drop pending delayed pushes so shutdown does not emit stragglers
    try {
      ctx.effect(() => () => {
        for (const { timer } of pendingAgentErrors.values()) clearTimeout(timer)
        pendingAgentErrors.clear()
      }, 'dsh-qq-notify pending agent errors')
    } catch {}
  }

  // ---- agent-callable notify tool -----------------------------------------
  if (config.tool.enabled) {
    try {
      const disposer = await registerNotifyTool(ctx, dispatcher, limiter, config)
      if (disposer) disposers.push(disposer)
    } catch (error) {
      console.error(`[${PLUGIN_ID}] notify tool registration failed (continuing without it): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---- dispose -------------------------------------------------------------
  try {
    ctx.effect(() => () => {
      try {
        completedDebouncer.dispose()
      } catch {}
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {}
      }
    }, 'dsh-qq-notify cleanup')
  } catch {
    // effect unavailable (already-inactive context): nothing to clean up; harmless.
  }
}

/** Read the last assistant text from a live session; failures degrade to ''. */
function readAssistantExcerpt (session, maxChars) {
  try {
    const events = session.snapshotEvents()
    return lastAssistantExcerpt(events, maxChars)
  } catch (error) {
    console.error(`[${PLUGIN_ID}] snapshotEvents failed: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

/** Register the notify tool; returns its disposer. */
async function registerNotifyTool (ctx, dispatcher, limiter, config) {
  if (typeof ctx?.tools?.register !== 'function') {
    console.error(`[${PLUGIN_ID}] tools registry unavailable; notify tool not registered`)
    return undefined
  }
  const push = async (content) => dispatcher.push('tool', content)
  const definition = await createNotifyTool(push, limiter, { serverName: config.serverName })
  return ctx.tools.register(definition)
}

/**
 * Cordis plugin export shape (matches dsh-rewind-plugin / dsh-tool-todo):
 * named exports only — `unwrapExports` prefers a default export when present,
 * which would drop `inject` and `name`.
 */
export const name = PLUGIN_ID

