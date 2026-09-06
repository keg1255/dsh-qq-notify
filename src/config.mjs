/**
 * dsh-qq-notify config normalization.
 *
 * The cordis loader hands the plugin the patch-merged config row verbatim.
 * Normalize defensively here: the plugin must never throw at startup because a
 * user layer replaced a nested object with a scalar (patch semantics are
 * whole-field replacement, not deep merge). Invalid values fall back to
 * defaults; nothing here throws.
 */

const RELAY_URL_DEFAULT = 'http://notice.inu1255.cn/qq/send';

const DEFAULTS = Object.freeze({
  enabled: true,
  url: RELAY_URL_DEFAULT,
  openid: '',
  debounceMs: 10_000,
  summaryMaxChars: 500,
  timeoutMs: 10_000,
  events: Object.freeze({ turnEnd: true, approval: true, askUser: true, agentError: true }),
  tool: Object.freeze({ enabled: true, rateLimitPerMinute: 10 }),
  /**
   * agent/error dedup: agent/error waits this long before sending; a
   * turn/end error for the same session arriving within the window cancels
   * it (one provider failure would otherwise notify twice — once via the
   * session's turn/end error and once via the agent bus).
   */
  agentErrorDelayMs: 5_000,
});

function asBool (value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function asIntInRange (value, fallback, { min, max }) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(n)) return fallback
  const clamped = Math.trunc(n)
  if (clamped < min) return min
  if (max !== undefined && clamped > max) return max
  return clamped
}

function normalizeEvents (raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return Object.freeze({
    turnEnd: asBool(source.turnEnd, DEFAULTS.events.turnEnd),
    approval: asBool(source.approval, DEFAULTS.events.approval),
    askUser: asBool(source.askUser, DEFAULTS.events.askUser),
    agentError: asBool(source.agentError, DEFAULTS.events.agentError),
  })
}

function normalizeTool (raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return Object.freeze({
    enabled: asBool(source.enabled, DEFAULTS.tool.enabled),
    rateLimitPerMinute: asIntInRange(source.rateLimitPerMinute, DEFAULTS.tool.rateLimitPerMinute, { min: 0, max: 600 }),
  })
}

/**
 * Normalize a raw config row into the plugin's internal config.
 * @param raw - loader-provided config (may be undefined or arbitrarily shaped).
 * @returns frozen, fully-defaulted config object.
 */
export function resolveConfig (raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const url = typeof source.url === 'string' && source.url.trim() !== '' ? source.url.trim() : DEFAULTS.url
  const openid = typeof source.openid === 'string' ? source.openid.trim() : ''
  return Object.freeze({
    enabled: asBool(source.enabled, DEFAULTS.enabled),
    url,
    openid,
    debounceMs: asIntInRange(source.debounceMs, DEFAULTS.debounceMs, { min: 0, max: 10 * 60 * 1000 }),
    summaryMaxChars: asIntInRange(source.summaryMaxChars, DEFAULTS.summaryMaxChars, { min: 40, max: 4000 }),
    timeoutMs: asIntInRange(source.timeoutMs, DEFAULTS.timeoutMs, { min: 1000, max: 60 * 1000 }),
    agentErrorDelayMs: asIntInRange(source.agentErrorDelayMs, DEFAULTS.agentErrorDelayMs, { min: 0, max: 60 * 1000 }),
    events: normalizeEvents(source.events),
    tool: normalizeTool(source.tool),
  })
}

export { DEFAULTS, RELAY_URL_DEFAULT }
