/**
 * Tests for dsh-qq-notify target resolution: config list normalization,
 * `.dsh-qq-notify-openids` parsing, and merge semantics.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROJECT_OPENID_FILE,
  normalizeOpenidList,
  parseOpenidFile,
  readProjectOpenids,
  mergeOpenids,
  dedupe,
} from '../src/targets.mjs'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('normalizeOpenidList: string, list, nested and mixed shapes flatten', () => {
  assert.deepEqual(normalizeOpenidList('A'), ['A'])
  assert.deepEqual(normalizeOpenidList(['A', 'B']), ['A', 'B'])
  assert.deepEqual(normalizeOpenidList('A, B'), ['A', 'B'])
  assert.deepEqual(normalizeOpenidList('A\nB'), ['A', 'B'])
  assert.deepEqual(normalizeOpenidList([' A ', '', 'B']), ['A', 'B'])
  assert.deepEqual(normalizeOpenidList([['A'], ['B', ['C']]]), ['A', 'B', 'C'])
})

test('normalizeOpenidList: preserves order and drops duplicates exactly', () => {
  assert.deepEqual(normalizeOpenidList(['B', 'A', 'B', 'C', 'A']), ['B', 'A', 'C'])
  // openids are case-sensitive
  assert.deepEqual(normalizeOpenidList(['abc', 'ABC']), ['abc', 'ABC'])
})

test('normalizeOpenidList: hostile shapes degrade to [] without throwing', () => {
  for (const bad of [undefined, null, 42, true, {}, [], ['', '  ']]) {
    assert.deepEqual(normalizeOpenidList(bad), [], `input ${JSON.stringify(bad)}`)
  }
})

test('dedupe: ignores non-strings and blank entries', () => {
  assert.deepEqual(dedupe(['A', 42, null, 'A', ' B ', undefined]), ['A', 'B'])
  assert.deepEqual(dedupe('not-a-list'), [])
})

test('parseOpenidFile: one per line, comments and blank lines ignored', () => {
  const text = [
    '# 额外接收人',
    '',
    '   ',
    'OID-1',
    '  OID-2  ',
    'openid: OID-3',
    'openid=OID-4',
    'OID-1',
    '# trailing comment',
  ].join('\n')
  assert.deepEqual(parseOpenidFile(text), ['OID-1', 'OID-2', 'OID-3', 'OID-4'])
})

test('parseOpenidFile: CRLF and non-string input', () => {
  assert.deepEqual(parseOpenidFile('A\r\nB\r\n'), ['A', 'B'])
  assert.deepEqual(parseOpenidFile(undefined), [])
  assert.deepEqual(parseOpenidFile(''), [])
})

test('readProjectOpenids: reads the workspace file and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqn-targets-'))
  writeFileSync(join(dir, PROJECT_OPENID_FILE), 'P1\nP2\n')
  try {
    assert.deepEqual(readProjectOpenids(dir), ['P1', 'P2'])
    // missing file
    const empty = mkdtempSync(join(tmpdir(), 'qqn-targets-empty-'))
    assert.deepEqual(readProjectOpenids(empty), [])
    rmSync(empty, { recursive: true, force: true })
    // a directory where the file should be → read fails → []
    const dirAsFile = mkdtempSync(join(tmpdir(), 'qqn-targets-dir-'))
    mkdirSync(join(dirAsFile, PROJECT_OPENID_FILE))
    assert.deepEqual(readProjectOpenids(dirAsFile), [])
    rmSync(dirAsFile, { recursive: true, force: true })
    // unknown/blank dirs
    assert.deepEqual(readProjectOpenids(''), [])
    assert.deepEqual(readProjectOpenids(undefined), [])
    assert.deepEqual(readProjectOpenids(42), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeOpenids: config order wins, extras appended, duplicates collapse', () => {
  assert.deepEqual(mergeOpenids(['A', 'B'], ['B', 'C']), ['A', 'B', 'C'])
  assert.deepEqual(mergeOpenids([], ['X']), ['X'])
  assert.deepEqual(mergeOpenids(['X'], []), ['X'])
  assert.deepEqual(mergeOpenids(undefined, undefined), [])
})
