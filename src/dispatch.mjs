/**
 * dsh-qq-notify — dispatcher: dedup, debounce, notification pipeline.
 *
 * Pipeline: event → (dedup by `session.id:seq`, 24h bounded window) →
 * immediate or debounced send → relay POST → ledger line. Every step is
 * individually failure-isolated; dispatch() never throws into the host.
 */
import { buildRelayPayload, ensureNonEmpty } from './message.mjs'
import { dedupe } from './targets.mjs'

/** Retention window for dedup keys. */
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000
/** Hard cap on tracked dedup keys (oldest evicted first). */
const DEDUP_MAX_KEYS = 512

/**
 * Bounded 24h dedup window. Keys are strings; memory stays bounded by
 * evicting expired entries on insert and dropping the oldest beyond the cap.
 */
export class DedupWindow {
  #seen = new Map() // key -> first-seen epoch ms

  /**
   * Claim a key. Returns true when the key was unseen within the window.
   * @param key - stable identity string
   * @param now - epoch ms (injectable for tests)
   */
  claim (key, now = Date.now()) {
    const first = this.#seen.get(key)
    if (first !== undefined && now - first < DEDUP_WINDOW_MS) return false
    if (this.#seen.size >= DEDUP_MAX_KEYS) this.#sweep(now)
    this.#seen.set(key, now)
    return true
  }

  /** Drop expired entries; if still full after sweeping, drop the oldest. */
  #sweep (now) {
    for (const [key, first] of this.#seen) {
      if (now - first >= DEDUP_WINDOW_MS) this.#seen.delete(key)
    }
    while (this.#seen.size >= DEDUP_MAX_KEYS) {
      const oldest = this.#seen.keys().next().value
      this.#seen.delete(oldest)
    }
  }

  get size () {
    return this.#seen.size
  }
}

/**
 * 10s trailing-edge debounce for completed-turn notifications: bursts of
 * consecutive `completed` ends in one session collapse into a single push of
 * the last one. Non-completed kinds bypass the window.
 */
export class TurnEndDebouncer {
  #timers = new Map() // sessionId -> timer
  #delayMs

  constructor (delayMs) {
    this.#delayMs = Math.max(0, delayMs)
  }

  /**
   * Schedule a task for a session. A newer arrival for the same session
   * replaces the pending one (only the last runs).
   * @param sessionId - debounce scope
   * @param task - zero-arg async/sync function invoked after the delay
   */
  schedule (sessionId, task) {
    const existing = this.#timers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.#timers.delete(sessionId)
      Promise.resolve().then(task).catch((error) => {
        console.error(`[dsh-qq-notify] debounced push failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, this.#delayMs)
    this.#timers.set(sessionId, timer)
  }

  /** Cancel everything (plugin dispose). */
  dispose () {
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
  }

  /** Number of pending sessions (tests). */
  get pending () {
    return this.#timers.size
  }
}

/**
 * Push dispatcher. Wires the send chain: payload → relay → ledger, plus the
 * dedup window. (Completed-turn debouncing lives in the entry, which owns the
 * TurnEndDebouncer directly: the debounced body is built at fire time.)
 */
export class Dispatcher {
  #config
  #send
  #ledger
  #dedup = new DedupWindow()
  /**
   * Per-push extra targets: `(session) => string[]`. Wired by the entry to
   * merge `<workspace>/.dsh-qq-notify-openids` into the config targets.
   */
  #extraTargets

  /**
   * @param config - resolved plugin config (`openids` is the target list)
   * @param send - async `(payload) => sendResult`
   * @param ledger - ledger appender
   * @param extraTargets - optional `(session) => string[]` per-push targets
   */
  constructor (config, send, ledger, extraTargets) {
    this.#config = config
    this.#send = send
    this.#ledger = ledger
    this.#extraTargets = typeof extraTargets === 'function' ? extraTargets : () => []
  }

  /**
   * Resolve the target list for one push: config targets first, then the
   * per-session extras (cancelled/empty when `projectOpenids` is off).
   * @param session - live session (optional; may be undefined/null)
   * @returns de-duplicated string[]; may be empty (relay-level catch-all)
   */
  targetsFor (session) {
    let extra = []
    if (this.#config.projectOpenids !== false) {
      try {
        extra = this.#extraTargets(session) ?? []
      } catch (error) {
        console.error(`[dsh-qq-notify] project openid lookup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return dedupe([...(this.#config.openids ?? []), ...extra])
  }

  /**
   * Send one notification to every configured target (fan-out). Each target
   * gets its own relay POST and its own ledger line, so a per-recipient failure
   * (e.g. one openid never added the bot) never masks the others.
   *
   * With no targets at all the payload is still sent once without `openid`,
   * preserving the legacy behavior of letting the relay pick the recipient.
   *
   * @param kind - ledger kind, e.g. 'approval' | 'turn-end' | 'ask-user' | 'agent-error' | 'tool'
   * @param content - markdown body (made non-empty here as the last guard)
   * @param dedupKey - optional identity for 24h dedup; false skips the send
   * @param session - session the push belongs to (for project-openid lookup)
   * @param targets - explicit target override (the notify tool may pass `to`)
   * @returns `{ ok, delivered, failed, total, id? }`; undefined when deduped
   */
  async push (kind, content, dedupKey, session, targets) {
    if (dedupKey !== undefined) {
      if (!this.#dedup.claim(dedupKey)) return undefined
    }
    const safeContent = ensureNonEmpty(content, kind)
    const list = targets === undefined
      ? this.targetsFor(session)
      : dedupe(Array.isArray(targets) ? targets : [targets])
    // No targets: one legacy anonymous send (relay resolves the recipient).
    const recipients = list.length > 0 ? list : [undefined]

    const started = Date.now()
    const results = []
    for (const openid of recipients) {
      const payload = buildRelayPayload(openid, safeContent)
      let result
      try {
        result = await this.#send(payload)
      } catch (error) {
        result = { ok: false, attempts: 1, failures: [{ channel: 'qq-relay', error: error instanceof Error ? error.message : String(error) }] }
      }
      results.push({ openid, result })
      // Ledger failures carry the target so a multi-openid ledger stays readable.
      const failed = result.failures?.length
        ? result.failures.map((failure) => (openid !== undefined ? { ...failure, openid } : failure))
        : undefined
      try {
        this.#ledger.append({
          at: new Date(started).toISOString(),
          kind,
          title: kind,
          contentLength: safeContent.length,
          delivered: result.ok === true,
          ...(openid !== undefined ? { openid } : {}),
          ...failed ? { failed } : {},
          ...result.ok && result.id ? { relayId: result.id } : {},
          elapsedMs: Date.now() - started,
        })
      } catch (error) {
        console.error(`[dsh-qq-notify] ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!result.ok) {
        console.error(`[dsh-qq-notify] push failed (${kind}${openid !== undefined ? ` → ${openid}` : ''}): ${result.error ?? 'unknown'}`)
      }
    }

    const failures = results
      .filter(({ result }) => result.ok !== true)
      .flatMap(({ openid, result }) => (result.failures?.length
        ? result.failures.map((failure) => (openid !== undefined ? { ...failure, openid } : failure))
        : [{ channel: 'qq-relay', ...(openid !== undefined ? { openid } : {}), error: result.error ?? 'unknown error' }]))
    const delivered = results.filter(({ result }) => result.ok === true)
    /** Any failed target makes the push `ok: false`, even when others succeeded. */
    const allDelivered = results.every(({ result }) => result.ok === true)
    const summary = {
      ok: results.length > 0 && allDelivered,
      delivered: delivered.length,
      total: results.length,
      attempts: Math.max(...results.map(({ result }) => result.attempts ?? 1), 1),
      failures,
    }
    // Single recipient: surface the relay id and exit code exactly as before.
    if (results.length === 1) {
      const only = results[0].result
      if (only.ok) summary.id = only.id
      else summary.error = only.error
    } else if (failures.length > 0) {
      summary.error = `${failures.length}/${results.length} targets failed`
    }
    return summary
  }
}
