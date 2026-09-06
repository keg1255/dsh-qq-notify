/**
 * dsh-qq-notify — dispatcher: dedup, debounce, notification pipeline.
 *
 * Pipeline: event → (dedup by `session.id:seq`, 24h bounded window) →
 * immediate or debounced send → relay POST → ledger line. Every step is
 * individually failure-isolated; dispatch() never throws into the host.
 */
import { buildRelayPayload, ensureNonEmpty } from './message.mjs'

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

  constructor (config, send, ledger) {
    this.#config = config
    this.#send = send
    this.#ledger = ledger
  }

  /**
   * Send one notification immediately.
   * @param kind - ledger kind, e.g. 'approval' | 'turn-end' | 'ask-user' | 'agent-error' | 'tool'
   * @param content - markdown body (made non-empty here as the last guard)
   * @param dedupKey - optional identity for 24h dedup; false skips the send
   * @returns the send result, or undefined when deduped
   */
  async push (kind, content, dedupKey) {
    if (dedupKey !== undefined) {
      if (!this.#dedup.claim(dedupKey)) return undefined
    }
    const safeContent = ensureNonEmpty(content, kind)
    const payload = buildRelayPayload(this.#config.openid, safeContent)
    const started = Date.now()
    let result
    try {
      result = await this.#send(payload)
    } catch (error) {
      result = { ok: false, attempts: 1, failures: [{ channel: 'qq-relay', error: error instanceof Error ? error.message : String(error) }] }
    }
    try {
      this.#ledger.append({
        at: new Date(started).toISOString(),
        kind,
        title: kind,
        contentLength: safeContent.length,
        delivered: result.ok === true,
        ...result.failures?.length ? { failed: result.failures } : {},
        ...result.ok && result.id ? { relayId: result.id } : {},
        elapsedMs: Date.now() - started,
      })
    } catch (error) {
      console.error(`[dsh-qq-notify] ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!result.ok) {
      console.error(`[dsh-qq-notify] push failed (${kind}): ${result.error ?? 'unknown'}`)
    }
    return result
  }
}
