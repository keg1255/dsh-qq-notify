/**
 * dsh-qq-notify state directory resolution.
 *
 * Convention: ~/.dsh/<plugin-name>/ holds the plugin's JSONL ledger. Resolution
 * never throws — if the home cannot be determined the caller degrades to
 * ledger-less operation.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLUGIN_DIR_NAME = 'dsh-qq-notify'

/**
 * Resolve the plugin's state directory. $DSH_HOME wins over the OS home.
 * @returns absolute directory path; never throws.
 */
export function resolveStateDir (env = process.env) {
  try {
    const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
      ? env.DSH_HOME.trim()
      : join(homedir(), '.dsh')
    return join(home, PLUGIN_DIR_NAME)
  } catch {
    return ''
  }
}

/** Absolute ledger path for a state dir; '' input yields '' (ledger disabled). */
export function ledgerPathFor (stateDir) {
  if (typeof stateDir !== 'string' || stateDir === '') return ''
  return join(stateDir, 'ledger.jsonl')
}
