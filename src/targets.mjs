/**
 * dsh-qq-notify — delivery target resolution.
 *
 * Every push fans out to a list of openids rather than a single one. Targets
 * come from two sources, merged in this order:
 *
 *   1. plugin config — `openid: '<id>'`, `openid: ['<id>', …]` or the
 *      `openids: […]` alias (all of them are sent)
 *   2. `<workspace>/.dsh-qq-notify-openids` — extra recipients, one per line,
 *      resolved per push from the session's `header.cwd`
 *
 * Resolution never throws: a missing/unreadable file, a bad config shape or a
 * malicious path degrade to "no extra targets" so the notification still goes
 * out to whatever the config provided.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Per-workspace extra-recipient file name. */
export const PROJECT_OPENID_FILE = '.dsh-qq-notify-openids'

/**
 * Flatten `string | Array<string|…>` into a de-duplicated, order-stable list.
 * Strings are split on whitespace, commas and semicolons so a YAML scalar like
 * `openid: 'A, B'` behaves like a list. Non-strings are ignored.
 * @param raw - config value (any shape)
 * @returns string[] (possibly empty)
 */
export function normalizeOpenidList (raw) {
  const out = []
  collect(raw, out)
  return dedupe(out)
}

function collect (raw, out) {
  if (typeof raw === 'string') {
    for (const part of raw.split(/[\s,;]+/)) {
      const id = part.trim()
      if (id !== '') out.push(id)
    }
    return
  }
  if (Array.isArray(raw)) {
    for (const item of raw) collect(item, out)
  }
}

/** Order-stable de-duplication (exact match — openids are case-sensitive). */
export function dedupe (list) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Parse a `.dsh-qq-notify-openids` file body.
 * One openid per line; blank lines and `#` comments are ignored; an optional
 * `openid=` / `openid:` prefix is tolerated for readability.
 * @param text - file contents
 * @returns string[] de-duplicated openids
 */
export function parseOpenidFile (text) {
  if (typeof text !== 'string' || text === '') return []
  const out = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const value = line.replace(/^openid\s*[:=]\s*/i, '').trim()
    if (value !== '') out.push(value)
  }
  return dedupe(out)
}

/**
 * Read `<dir>/.dsh-qq-notify-openids`. Never throws.
 * @param dir - workspace directory (session `header.cwd`)
 * @returns string[] (empty when the dir is unknown, the file is absent, or the read fails)
 */
export function readProjectOpenids (dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return []
  try {
    return parseOpenidFile(readFileSync(join(dir.trim(), PROJECT_OPENID_FILE), 'utf8'))
  } catch {
    return []
  }
}

/**
 * Merge config targets with per-workspace extras. Config wins on order;
 * duplicates collapse onto their first occurrence.
 * @param configOpenids - config-provided openids
 * @param extra - project-file openids
 * @returns string[] de-duplicated union
 */
export function mergeOpenids (configOpenids, extra) {
  return dedupe([
    ...(Array.isArray(configOpenids) ? configOpenids : []),
    ...(Array.isArray(extra) ? extra : []),
  ])
}
