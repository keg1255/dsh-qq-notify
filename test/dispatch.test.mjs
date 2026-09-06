/**
 * Tests for dsh-qq-notify dispatch: dedup, debounce, relay send, ledger.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DedupWindow, TurnEndDebouncer, Dispatcher } from '../src/dispatch.mjs'
import { SlidingWindowLimiter } from '../src/rate-limit.mjs'
import { createLedger } from '../src/ledger.mjs'
import { sendToRelay } from '../src/relay.mjs'
import { createNotifyTool } from '../src/notify-tool.mjs'
import { resolveConfig } from '../src/config.mjs'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- DedupWindow -----------------------------------------------------------

test('DedupWindow: same key within 24h dedupes; different keys pass', () => {
  const win = new DedupWindow()
  assert.equal(win.claim('a:1', 1000), true)
  assert.equal(win.claim('a:1', 2000), false)
  assert.equal(win.claim('a:2', 2000), true)
})

test('DedupWindow: key expires after 24h', () => {
  const win = new DedupWindow()
  assert.equal(win.claim('a:1', 0), true)
  assert.equal(win.claim('a:1', 24 * 3600 * 1000 - 1), false)
  assert.equal(win.claim('a:1', 24 * 3600 * 1000 + 1), true)
})

test('DedupWindow: bounded — stays under hard cap', () => {
  const win = new DedupWindow()
  for (let i = 0; i < 2000; i += 1) win.claim(`k${i}`, 1000 + i)
  assert.ok(win.size <= 512, `size ${win.size} must be bounded`)
})

// ---- TurnEndDebouncer --------------------------------------------------------

test('TurnEndDebouncer: only the last task per session fires after the window', async () => {
  const fired = []
  const debouncer = new TurnEndDebouncer(20)
  debouncer.schedule('s1', () => fired.push('first'))
  debouncer.schedule('s1', () => fired.push('second'))
  debouncer.schedule('s2', () => fired.push('other-session'))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(fired.sort(), ['other-session', 'second'])
  assert.equal(debouncer.pending, 0)
})

test('TurnEndDebouncer: dispose cancels pending tasks', async () => {
  const fired = []
  const debouncer = new TurnEndDebouncer(20)
  debouncer.schedule('s1', () => fired.push('x'))
  debouncer.dispose()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(fired, [])
})

test('TurnEndDebouncer: zero delay fires on next tick', async () => {
  const fired = []
  const debouncer = new TurnEndDebouncer(0)
  debouncer.schedule('s1', () => fired.push('now'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(fired, ['now'])
})

// ---- Dispatcher (send chain + ledger) ----------------------------------------

function tempLedgerPath () {
  return join(mkdtempSync(join(tmpdir(), 'qqn-')), 'ledger.jsonl')
}

test('Dispatcher: push delivers via injected sender and appends ledger line', async () => {
  const sends = []
  const path = tempLedgerPath()
  const dispatcher = new Dispatcher(
    resolveConfig({ openid: 'OID' }),
    async (payload) => {
      sends.push(payload)
      return { ok: true, id: 'R1', attempts: 1, failures: [] }
    },
    createLedger(path),
  )
  const result = await dispatcher.push('approval', '🔐 body', 'sess:1')
  assert.equal(result.ok, true)
  assert.equal(sends.length, 1)
  assert.equal(sends[0].openid, 'OID')
  assert.equal(sends[0].content, '🔐 body')
  assert.ok(existsSync(path))
  const line = JSON.parse(readFileSync(path, 'utf8').trim())
  assert.equal(line.kind, 'approval')
  assert.equal(line.delivered, true)
  assert.equal(line.contentLength, '🔐 body'.length)
  assert.equal(line.failed, undefined)
})

test('Dispatcher: content made non-empty at the dispatcher as last guard', async () => {
  const sends = []
  const dispatcher = new Dispatcher(
    resolveConfig({ openid: 'OID' }),
    async (payload) => {
      sends.push(payload)
      return { ok: true, attempts: 1, failures: [] }
    },
    createLedger(''),
  )
  await dispatcher.push('turn-end:completed', '')
  assert.ok(sends[0].content.length > 0, 'dispatcher must never emit empty content')
})

test('Dispatcher: sender throw is caught, ledgered as failure, never rethrown', async () => {
  const path = tempLedgerPath()
  const dispatcher = new Dispatcher(
    resolveConfig({ openid: 'OID' }),
    async () => {
      throw new Error('network gone')
    },
    createLedger(path),
  )
  const result = await dispatcher.push('tool', 'hello')
  assert.equal(result.ok, false)
  assert.match(result.failures[0].error, /network gone/)
  const line = JSON.parse(readFileSync(path, 'utf8').trim())
  assert.equal(line.delivered, false)
  assert.match(line.failed[0].error, /network gone/)
})

test('Dispatcher: dedup suppresses the second push of the same key', async () => {
  const sends = []
  const dispatcher = new Dispatcher(
    resolveConfig({ openid: 'OID' }),
    async (payload) => {
      sends.push(payload)
      return { ok: true, attempts: 1, failures: [] }
    },
    createLedger(''),
  )
  const first = await dispatcher.push('approval', 'body', 's:5')
  const second = await dispatcher.push('approval', 'body', 's:5')
  assert.equal(first?.ok, true)
  assert.equal(second, undefined)
  assert.equal(sends.length, 1)
})

test('Dispatcher: ledger write failure does not break the push', async () => {
  const dispatcher = new Dispatcher(
    resolveConfig({ openid: 'OID' }),
    async () => ({ ok: true, attempts: 1, failures: [] }),
    createLedger('/proc/definitely-not-writable/ledger.jsonl'),
  )
  const result = await dispatcher.push('tool', 'hi')
  assert.equal(result.ok, true)
})

// ---- relay (real HTTP against a local server) ---------------------------------

test('sendToRelay: success parses relay ok+id', async () => {
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      if (!parsed.content || parsed.content === '') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'content is required' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result: { id: 'ROBOT1.0_test' } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/qq/send`
  try {
    const config = resolveConfig({ url, openid: 'OID', timeoutMs: 3000 })
    const result = await sendToRelay(config, { openid: 'OID', content: 'hello' })
    assert.equal(result.ok, true)
    assert.equal(result.id, 'ROBOT1.0_test')
  } finally {
    server.close()
  }
})

test('sendToRelay: 500 with relay error text surfaces verbatim, no retry on 4xx/5xx-with-body', async () => {
  const { createServer } = await import('node:http')
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'content is required' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/qq/send`
  try {
    const config = resolveConfig({ url, openid: 'OID', timeoutMs: 3000 })
    const result = await sendToRelay(config, { openid: 'OID', content: '' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'content is required')
    assert.equal(result.failures.some((f) => f.error === 'content is required'), true)
  } finally {
    server.close()
  }
})

test('sendToRelay: connection refused reports error and retries once (transient)', async () => {
  const config = resolveConfig({ url: 'http://127.0.0.1:9/qq/send', timeoutMs: 2000 })
  const result = await sendToRelay(config, { openid: 'OID', content: 'hello' })
  assert.equal(result.ok, false)
  assert.equal(result.attempts, 2, 'network errors are treated as transient and retried once')
  assert.equal(result.failures.length, 2)
  assert.ok(result.failures.every((f) => f.channel === 'qq-relay' && f.error.length > 0))
})

test('sendToRelay: empty-content payload gets 500 like the real relay', async () => {
  // End-to-end against a faithful mock of the live relay's contract.
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      if (typeof parsed.content !== 'string' || parsed.content === '') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'content is required' }))
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: { id: 'x' } }))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const config = resolveConfig({ url: `http://127.0.0.1:${server.address().port}/qq/send`, timeoutMs: 3000 })
    const bad = await sendToRelay(config, { openid: 'OID', content: '' })
    assert.equal(bad.ok, false)
    assert.equal(bad.error, 'content is required')
  } finally {
    server.close()
  }
})

// ---- ledger --------------------------------------------------------------------

test('createLedger: disabled ledger is a silent no-op', () => {
  const ledger = createLedger('')
  ledger.append({ at: 'now', kind: 'x' })
  assert.equal(ledger.failed, 0)
})

test('createLedger: unwritable path counts failures instead of throwing', () => {
  const ledger = createLedger('/proc/definitely-not-writable/ledger.jsonl')
  ledger.append({ at: 'now', kind: 'x', delivered: false })
  assert.ok(ledger.failed >= 1)
})

test('createLedger: creates missing directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqn-'))
  const path = join(dir, 'nested', 'ledger.jsonl')
  const ledger = createLedger(path)
  ledger.append({ at: 'now', kind: 't', delivered: true })
  assert.ok(existsSync(path))
  rmSync(dir, { recursive: true, force: true })
})

// ---- rate limiter ----------------------------------------------------------------

test('SlidingWindowLimiter: admits up to the limit then blocks', () => {
  const limiter = new SlidingWindowLimiter(3, 1000)
  assert.equal(limiter.tryAcquire(0).ok, true)
  assert.equal(limiter.tryAcquire(1).ok, true)
  assert.equal(limiter.tryAcquire(2).ok, true)
  const blocked = limiter.tryAcquire(3)
  assert.equal(blocked.ok, false)
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000)
})

test('SlidingWindowLimiter: window slides — old hits expire', () => {
  const limiter = new SlidingWindowLimiter(2, 1000)
  limiter.tryAcquire(0)
  limiter.tryAcquire(10)
  assert.equal(limiter.tryAcquire(1100).ok, true) // first hit (t=0) expired
})

test('SlidingWindowLimiter: zero limit blocks everything', () => {
  const limiter = new SlidingWindowLimiter(0)
  assert.equal(limiter.tryAcquire().ok, false)
})

// ---- notify tool -------------------------------------------------------------------

test('notify tool: delivers message through the dispatcher push chain', async () => {
  const sends = []
  const tool = await createNotifyTool(
    async (content) => {
      sends.push(content)
      return { ok: true, attempts: 1, failures: [] }
    },
    new SlidingWindowLimiter(10),
  )
  assert.equal(tool.name, 'notify')
  assert.ok(tool.parameters.required.includes('message'))
  const value = await tool.execute({ message: 'hi from agent', title: '测试' }, {})
  assert.deepEqual(value, { delivered: true })
  assert.ok(sends[0].includes('hi from agent'))
  assert.ok(sends[0].includes('测试'))
})

test('notify tool: empty message still produces non-empty content', async () => {
  const sends = []
  const tool = await createNotifyTool(
    async (content) => {
      sends.push(content)
      return { ok: true, attempts: 1, failures: [] }
    },
    new SlidingWindowLimiter(10),
  )
  await tool.execute({ message: '' }, {})
  assert.ok(sends[0].length > 0)
})

test('notify tool: rate limited after the configured burst', async () => {
  const sends = []
  const tool = await createNotifyTool(
    async (content) => {
      sends.push(content)
      return { ok: true, attempts: 1, failures: [] }
    },
    new SlidingWindowLimiter(2),
  )
  assert.equal((await tool.execute({ message: '1' }, {})).delivered, true)
  assert.equal((await tool.execute({ message: '2' }, {})).delivered, true)
  const third = await tool.execute({ message: '3' }, {})
  assert.equal(third.delivered, false)
  assert.match(third.detail, /rate limited/)
  assert.equal(sends.length, 2)
})

test('notify tool: send failure surfaces detail to the agent', async () => {
  const tool = await createNotifyTool(
    async () => ({ ok: false, error: 'HTTP 500', attempts: 1, failures: [{ channel: 'qq-relay', error: 'HTTP 500' }] }),
    new SlidingWindowLimiter(10),
  )
  const value = await tool.execute({ message: 'x' }, {})
  assert.equal(value.delivered, false)
  assert.equal(value.detail, 'HTTP 500')
})
