/**
 * dsh-qq-notify — JSONL delivery ledger.
 *
 * cordis logger output is a black hole under the web profile (not routed to
 * stdout/stderr), so every push — success or failure — is appended here as one
 * JSON line:
 *   { at, kind, title, contentLength, delivered, failed: [{channel, error}] }
 *
 * The `failed[].error` entries carry the verbatim failure text. Ledger
 * failures themselves (disk full, permissions) are reported to console.error
 * and otherwise swallowed: losing a ledger line must never break a push.
 */
import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Create a ledger appender. Returns a no-op writer when `path` is ''.
 * @param path - absolute ledger.jsonl path ('' disables the ledger)
 * @returns `{ append(record) }`
 */
export function createLedger (path) {
  if (typeof path !== 'string' || path === '') {
    return Object.freeze({ append () {}, get failed () { return 0 } })
  }
  let dirEnsured = false
  let failures = 0
  const ensureDir = () => {
    if (dirEnsured) return
    mkdirSync(dirname(path), { recursive: true })
    dirEnsured = true
  }
  return Object.freeze({
    /**
     * Append one record. Thrown/serialization errors go to console.error and
     * are counted; they never propagate.
     */
    append (record) {
      try {
        let line
        try {
          line = JSON.stringify(record)
        } catch {
          line = JSON.stringify({
            at: record?.at,
            kind: record?.kind,
            title: record?.title,
            contentLength: record?.contentLength,
            delivered: false,
            failed: [{ channel: 'ledger', error: 'record failed to serialize' }],
          })
        }
        try {
          ensureDir()
        } catch (error) {
          failures += 1
          console.error(`[dsh-qq-notify] ledger mkdir failed: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        appendFileSync(path, line + '\n', { encoding: 'utf8' })
      } catch (error) {
        failures += 1
        console.error(`[dsh-qq-notify] ledger append failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    /** Number of ledger write failures observed (diagnostics/tests). */
    get failed () {
      return failures
    },
  })
}
