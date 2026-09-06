/**
 * Tests for dsh-qq-notify config resolution.
 * Run: node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, DEFAULTS } from '../src/config.mjs'

test('resolveConfig: empty object yields all defaults', () => {
  const config = resolveConfig({})
  assert.equal(config.enabled, true)
  assert.equal(config.url, 'http://notice.inu1255.cn/qq/send')
  assert.equal(config.openid, '')
  assert.equal(config.debounceMs, 10_000)
  assert.equal(config.summaryMaxChars, 500)
  assert.deepEqual(config.events, { turnEnd: true, approval: true, askUser: true, agentError: true })
  assert.deepEqual(config.tool, { enabled: true, rateLimitPerMinute: 10 })
})

test('resolveConfig: no argument behaves like empty object', () => {
  const config = resolveConfig()
  assert.equal(config.debounceMs, DEFAULTS.debounceMs)
  assert.equal(config.url, DEFAULTS.url)
})

test('resolveConfig: non-object input degrades to defaults instead of throwing', () => {
  for (const bad of [undefined, null, 42, 'x', [], true]) {
    const config = resolveConfig(bad)
    assert.equal(config.url, DEFAULTS.url)
    assert.equal(config.debounceMs, DEFAULTS.debounceMs)
  }
})

test('resolveConfig: explicit values override defaults', () => {
  const config = resolveConfig({
    enabled: false,
    url: 'http://127.0.0.1:9/qq',
    openid: 'ABC123',
    debounceMs: 1500,
    summaryMaxChars: 200,
    events: { turnEnd: false },
    tool: { rateLimitPerMinute: 3 },
  })
  assert.equal(config.enabled, false)
  assert.equal(config.url, 'http://127.0.0.1:9/qq')
  assert.equal(config.openid, 'ABC123')
  assert.equal(config.debounceMs, 1500)
  assert.equal(config.summaryMaxChars, 200)
  // partially specified sub-objects: listed keys override, others keep defaults
  assert.equal(config.events.turnEnd, false)
  assert.equal(config.events.approval, true)
  assert.equal(config.tool.rateLimitPerMinute, 3)
  assert.equal(config.tool.enabled, true)
})

test('resolveConfig: invalid values fall back to defaults', () => {
  const config = resolveConfig({
    enabled: 'not-a-bool',
    debounceMs: -5,
    summaryMaxChars: 99999,
    url: '   ',
    openid: 12345,
  })
  assert.equal(config.enabled, true)
  assert.equal(config.debounceMs, 0) // clamped, not defaulted: -5 clamps to min 0
  assert.equal(config.summaryMaxChars, 4000) // clamped to max
  assert.equal(config.url, DEFAULTS.url) // blank string → default
  assert.equal(config.openid, '') // non-string → ''
})

test('resolveConfig: string booleans and numeric strings are tolerated', () => {
  const config = resolveConfig({ enabled: 'false', debounceMs: '2000' })
  assert.equal(config.enabled, false)
  assert.equal(config.debounceMs, 2000)
})

test('resolveConfig: result is frozen (accidental mutation throws in strict mode)', () => {
  const config = resolveConfig({})
  assert.throws(() => {
    'use strict'
    config.enabled = false
  })
  assert.throws(() => {
    'use strict'
    config.events.turnEnd = false
  })
})
