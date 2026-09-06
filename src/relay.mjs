/**
 * dsh-qq-notify — QQ relay sender (webhook adapter).
 *
 * POST JSON { openid, content } to the relay. Behavior verified against the
 * live relay (2025-09):
 *   - content required and non-empty; empty → 500 {"ok":false,"error":"content is required"}
 *   - openid accepted via query or body; extra body fields ignored
 *   - 200 {"ok":true,"result":{"id":"ROBOT1.0_..."}}
 *
 * send() never throws: every failure is returned as a result object so the
 * listener can ledger it and keep the host untouched.
 */

const RELAY_OK = 'ok'

/**
 * POST the payload to the relay once.
 * @param url - relay endpoint
 * @param payload - `{ openid?, content }` (content already non-empty)
 * @param timeoutMs - fetch timeout
 * @returns `{ ok, id?, error?, httpStatus? }`
 */
async function postOnce (url, payload, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('relay request timed out')), Math.max(1000, timeoutMs))
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const httpStatus = response.status
    let body = null
    try {
      body = await response.json()
    } catch {
      // non-JSON body: fall through to status-based verdict
    }
    if (!response.ok) {
      const detail = body && typeof body === 'object' && typeof body.error === 'string'
        ? body.error
        : `HTTP ${httpStatus}`
      return { ok: false, error: detail, httpStatus }
    }
    if (body && typeof body === 'object' && body[RELAY_OK] === true) {
      const id = body.result && typeof body.result === 'object' ? body.result.id : undefined
      return { ok: true, id, httpStatus }
    }
    return { ok: false, error: `unexpected relay response: HTTP ${httpStatus}`, httpStatus }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Send one notification with one retry on transient failure (network error,
 * 5xx). The retry halves the risk from single blips without a dependency on
 * any queue.
 * @param config - resolved plugin config (url, timeoutMs)
 * @param payload - `{ openid?, content }`
 * @returns `{ ok, id?, attempts, error?, failures }` — failures carries the
 *   verbatim error of every failed attempt for the ledger.
 */
export async function sendToRelay (config, payload) {
  const attempts = []
  const maxAttempts = 2
  let last = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await postOnce(config.url, payload, config.timeoutMs)
    last = result
    attempts.push(result)
    if (result.ok) break
    const transient = result.httpStatus === undefined || result.httpStatus >= 500
    if (!transient) break
  }
  if (last.ok) return { ok: true, id: last.id, attempts: attempts.length, failures: [] }
  return {
    ok: false,
    attempts: attempts.length,
    error: last.error,
    failures: attempts
      .filter((a) => !a.ok)
      .map((a) => ({ channel: 'qq-relay', error: a.error ?? 'unknown error' })),
  }
}
