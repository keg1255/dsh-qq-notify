/**
 * dsh-qq-notify — host event wiring.
 *
 * Session events are dispatched through cordis scope carriers. If the plugin
 * context were itself scope-limited it would never see them (the failure mode
 * that killed dsh-notifier). Two independent defenses:
 *
 *   1. Resolve the ROOT context: a root context satisfies `ctx.root === ctx`.
 *      All subscriptions attach there when reachable, falling back to the
 *      plugin's own context otherwise.
 *   2. Every listener registers with `{ global: true }` — cordis keeps such
 *      hooks outside scope filtering (`hook.global || !filter`), which is how
 *      dsh-rewind-plugin (bundled with this profile) receives session events.
 */

/**
 * Return the context to subscribe on: the root context when `ctx.root` is
 * present and self-referential, else the context itself. Never throws.
 */
export function resolveRootContext (ctx) {
  try {
    const root = ctx?.root
    if (root !== undefined && root !== null && root.root === root) return root
  } catch {
    // fall through
  }
  return ctx
}

/**
 * Subscribe a listener on the resolved root context with the global flag.
 * Returns the disposer returned by ctx.on, or undefined when subscription
 * failed (the caller logs and continues without that event line).
 */
export function subscribeGlobal (ctx, event, listener) {
  try {
    const root = resolveRootContext(ctx)
    return root.on(event, listener, { global: true })
  } catch (error) {
    console.error(`[dsh-qq-notify] subscribe ${event} failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
