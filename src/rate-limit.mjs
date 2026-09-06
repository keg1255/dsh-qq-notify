/**
 * dsh-qq-notify — sliding-window rate limiter (for the notify tool).
 *
 * Bounds agent-initiated pushes to N per rolling window. The window is a
 * timestamp ring: `tryAcquire` prunes entries older than the window, then
 * admits only when the ring is below the limit. No dependencies, no timers.
 */
export class SlidingWindowLimiter {
  #limit
  #windowMs
  #hits = []

  constructor (limit, windowMs = 60_000) {
    this.#limit = Math.max(0, Math.trunc(limit))
    this.#windowMs = windowMs
  }

  /**
   * Try to consume one slot.
   * @param now - epoch ms (injectable for tests)
   * @returns `{ ok: true }` or `{ ok: false, retryAfterMs }`
   */
  tryAcquire (now = Date.now()) {
    if (this.#limit === 0) return { ok: false, retryAfterMs: this.#windowMs }
    const cutoff = now - this.#windowMs
    while (this.#hits.length > 0 && this.#hits[0] <= cutoff) this.#hits.shift()
    if (this.#hits.length >= this.#limit) {
      const retryAfterMs = Math.max(1, this.#hits[0] + this.#windowMs - now)
      return { ok: false, retryAfterMs }
    }
    this.#hits.push(now)
    return { ok: true }
  }

  get size () {
    return this.#hits.length
  }
}
