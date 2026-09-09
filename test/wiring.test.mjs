/**
 * Wiring tests: drive the real plugin entry (apply) against a fake cordis
 * context and assert the full pipeline: subscription → assembly → dedup →
 * debounce → relay → ledger.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/plugin-entry.mjs'
import { resolveConfig } from '../src/config.mjs'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { hostname } from 'node:os'
import { join } from 'node:path'

/**
 * Minimal cordis-context stand-in: root self-reference, listener capture,
 * effect capture, tool registry capture.
 */
function makeFakeCtx ({ tools = true } = {}) {
  const listeners = new Map() // event -> [listener]
  const disposers = []
  const registeredTools = []
  const ctx = {
    on (event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      const dispose = () => {
        const list = listeners.get(event) ?? []
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
      disposers.push(dispose)
      return dispose
    },
    effect (setup) {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    emit (event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
  }
  if (tools) ctx.tools = { register: (definition) => { registeredTools.push(definition) } }
  ctx.root = ctx
  return { ctx, listeners, disposers, registeredTools }
}

function fakeSession (id, events) {
  return {
    id,
    header: { id },
    snapshotEvents: () => events,
  }
}

function assistantEvent (seq, text) {
  return {
    type: 'assistant/message',
    seq,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } },
  }
}

/** Drive apply with the config and a controllable sender. */
async function bootPlugin ({ config = {}, sendImpl, ctxOptions } = {}) {
  const sends = []
  const dir = mkdtempSync(join(tmpdir(), 'qqn-wire-'))
  const ledgerPath = join(dir, 'dsh-qq-notify', 'ledger.jsonl')
  const { ctx, listeners, disposers, registeredTools } = makeFakeCtx(ctxOptions)
  const sender = sendImpl ?? (async (payload) => {
    sends.push(payload)
    return { ok: true, id: 'ROBOT1.0_x', attempts: 1, failures: [] }
  })
  // Boot config: only fill openid when the caller did not pin it explicitly.
  const bootConfig = {
    ...config,
    url: 'http://127.0.0.1:1/qq/send', // never actually reached: fetch is mocked
    debounceMs: config.debounceMs ?? 0,
  }
  if (config.openid === undefined) bootConfig.openid = 'OID-TEST'

  // Install the fetch mock + DSH_HOME redirect for the whole test lifetime;
  // cleanup() restores both.
  const realFetch = globalThis.fetch
  const realDshHome = process.env.DSH_HOME
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body)
    const result = await sender(payload)
    if (result.ok) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { id: result.id ?? 'x' } }),
      }
    }
    return {
      ok: false,
      status: result.httpStatus ?? 500,
      json: async () => ({ ok: false, error: result.error ?? 'mock error' }),
    }
  }
  process.env.DSH_HOME = dir
  try {
    await apply(ctx, bootConfig)
  } catch (error) {
    globalThis.fetch = realFetch
    if (realDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realDshHome
    throw error
  }
  // Re-open the ledger file lazily per assertion.
  const readLedger = () => {
    if (!existsSync(ledgerPath)) return []
    return readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }
  return {
    ctx,
    listeners,
    disposers,
    registeredTools,
    sends,
    readLedger,
    cleanup: () => {
      globalThis.fetch = realFetch
      if (realDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = realDshHome
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 40))

test('apply: subscribes on the root context with global listeners', async () => {
  const { listeners, cleanup } = await bootPlugin()
  assert.ok(listeners.has('session/event'))
  assert.ok(listeners.has('agent/error'))
  assert.ok(listeners.has('user-questions/request'))
  cleanup()
})

test('apply: no-op when disabled or openid missing (no subscriptions)', async () => {
  for (const config of [{ enabled: false }, { openid: '' }]) {
    const { listeners, cleanup } = await bootPlugin({ config })
    assert.equal(listeners.size, 0, `no listeners for ${JSON.stringify(config)}`)
    cleanup()
  }
})

test('approval/asked: pushed instantly with tool name, non-empty content', async () => {
  const { ctx, sends, cleanup } = await bootPlugin()
  const session = fakeSession('sess-a', [])
  ctx.emit('session/event', session, {
    type: 'approval/asked',
    seq: 1,
    data: { id: 'r1', toolName: 'bash', reason: 'runs a command' },
  })
  await flush()
  assert.equal(sends.length, 1)
  assert.ok(sends[0].content.includes('🔐'))
  assert.ok(sends[0].content.includes('bash'))
  assert.ok(sends[0].content.length > 0)
  cleanup()
})

test('turn/end completed: debounced, last-of-burst wins, plain excerpt + server/workspace context', async () => {
  const { ctx, sends, cleanup } = await bootPlugin()
  const events = [
    assistantEvent(1, '中间消息'),
    assistantEvent(4, '最终回复：一切完成'),
  ]
  const session = fakeSession('sess-b', events)
  session.header = { id: 'sess-b', cwd: '/opt/dsh-qq-notify' }
  ctx.emit('session/event', session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('session/event', session, { type: 'turn/end', seq: 3, data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(sends.length, 0, 'no immediate push for completed')
  await flush()
  assert.equal(sends.length, 1, 'burst collapses into one push')
  assert.ok(sends[0].content.includes('最终回复：一切完成'))
  assert.ok(sends[0].content.includes('工作区：dsh-qq-notify'))
  assert.ok(sends[0].content.includes(hostname().replace(/\.local$/, '')), 'server name line present')
  assert.equal(sends[0].content.includes('✅'), false, 'no headline for completed')
  assert.equal(sends[0].content.includes('turn 2'), false, 'no turn line for completed')
  assert.equal(sends[0].content.includes('>'), false, 'no quote block')
  cleanup()
})

test('turn/end: non-completed kinds push instantly with mapped text', async () => {
  const { ctx, sends, cleanup } = await bootPlugin({ config: { agentErrorDelayMs: 0 } })
  const session = fakeSession('sess-c', [])
  ctx.emit('session/event', session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'aborted', reason: 'timeout' } } })
  await flush()
  assert.equal(sends.length, 1)
  assert.ok(sends[0].content.includes('⏹'))
  assert.ok(sends[0].content.includes('已中止'))
  cleanup()
})

test('turn/end: user-initiated abort is NOT pushed', async () => {
  const { ctx, sends, cleanup } = await bootPlugin()
  const session = fakeSession('sess-abort-user', [])
  ctx.emit('session/event', session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'aborted', reason: 'user' } } })
  await flush()
  assert.equal(sends.length, 0, 'the user pressed stop themselves — no push')
  cleanup()
})

test('turn/end: user abort as { kind: "user" } object is NOT pushed either', async () => {
  const { ctx, sends, cleanup } = await bootPlugin()
  const session = fakeSession('sess-abort-user-obj', [])
  ctx.emit('session/event', session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await flush()
  assert.equal(sends.length, 0, 'object-shaped cause normalizes to the same suppression')
  cleanup()
})

test('turn/end error: carries the provider error code and message', async () => {
  const { ctx, sends, cleanup } = await bootPlugin({ config: { agentErrorDelayMs: 0 } })
  const session = fakeSession('sess-err', [])
  ctx.emit('session/event', session, {
    type: 'turn/end',
    seq: 1,
    data: { turn: 6, reason: { kind: 'error', error: { code: 'SERVER', message: 'OpenAI API error (500): internal server error' } } },
  })
  await flush()
  assert.equal(sends.length, 1)
  assert.ok(sends[0].content.includes('❌'))
  assert.ok(sends[0].content.includes('`SERVER`'))
  assert.ok(sends[0].content.includes('OpenAI API error (500)'))
  cleanup()
})

test('turn/end: unknown kind is silently ignored', async () => {
  const { ctx, sends, cleanup } = await bootPlugin()
  const session = fakeSession('sess-d', [])
  ctx.emit('session/event', session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'warp-drive' } } })
  await flush()
  assert.equal(sends.length, 0)
  cleanup()
})

test('turn/end: non-completed push is deduped by session.id:seq', async () => {
  const { ctx, sends, cleanup } = await bootPlugin()
  const session = fakeSession('sess-e', [])
  const event = { type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } }
  ctx.emit('session/event', session, event)
  ctx.emit('session/event', session, event) // same seq → duplicate
  await flush()
  assert.equal(sends.length, 1)
  cleanup()
})

test('turn/end: different sessions do not collide in dedup', async () => {
  const { ctx, sends, cleanup } = await bootPlugin()
  const event = { type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'aborted', reason: 'timeout' } } }
  ctx.emit('session/event', fakeSession('sess-x', []), event)
  ctx.emit('session/event', fakeSession('sess-y', []), event)
  await flush()
  assert.equal(sends.length, 2)
  cleanup()
})

test('user-questions/request: pushed and strictly passed through to next()', async () => {
  const { ctx, sends, cleanup } = await bootPlugin()
  const question = {
    id: 'q1',
    header: '确认',
    question: '要继续吗？',
    options: [{ label: '继续' }, { label: '取消' }],
  }
  let delegated = false
  ctx.emit('user-questions/request', { questions: [question] }, async () => {
    delegated = true
    return { answers: [{ id: 'q1', selected: ['继续'] }] }
  })
  await flush()
  assert.ok(delegated, 'waterfall must be delegated, never consumed')
  assert.equal(sends.length, 1)
  assert.ok(sends[0].content.includes('💬'))
  assert.ok(sends[0].content.includes('[确认] 要继续吗？'))
  cleanup()
})

test('agent/error: pushed after the dedup grace with the error message', async () => {
  const { ctx, sends, cleanup } = await bootPlugin({ config: { agentErrorDelayMs: 200 } })
  ctx.emit('agent/error', { agent: { session: fakeSession('sess-f', []) }, turn: 3, error: { code: 'SERVER', message: 'provider 500' } })
  await flush()
  assert.equal(sends.length, 0, 'no push within the grace window')
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(sends.length, 1)
  assert.ok(sends[0].content.includes('🔥'))
  assert.ok(sends[0].content.includes('provider 500'))
  assert.ok(sends[0].content.includes('SERVER'), 'error code included')
  cleanup()
})

test('agent/error dedup: turn/end error same session cancels the delayed push', async () => {
  const { ctx, sends, cleanup } = await bootPlugin({ config: { agentErrorDelayMs: 40 } })
  const session = fakeSession('sess-dup', [])
  ctx.emit('agent/error', { agent: { session }, turn: 3, error: { code: 'SERVER', message: 'OpenAI API error (500)' } })
  ctx.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 3, reason: { kind: 'error', error: { code: 'SERVER', message: 'OpenAI API error (500)' } } } })
  await flush()
  assert.equal(sends.length, 1, 'only the richer turn-end push went out')
  assert.ok(sends[0].content.includes('❌'), 'the turn-end error push is the one delivered')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(sends.length, 1, 'delayed agent-error push was cancelled, not queued')
  cleanup()
})

test('agent/error dedup: same failure on a DIFFERENT session still pushes', async () => {
  const { ctx, sends, cleanup } = await bootPlugin({ config: { agentErrorDelayMs: 5 } })
  ctx.emit('agent/error', { agent: { session: fakeSession('sess-other', []) }, turn: 1, error: { message: 'boom' } })
  ctx.emit('session/event', fakeSession('sess-unrelated', []), { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'X', message: 'boom' } } } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(sends.length, 2, 'both pushes delivered (different sessions)')
  cleanup()
})

test('agent/error dedup: non-error turn ends do NOT cancel the pending push', async () => {
  const { ctx, sends, cleanup } = await bootPlugin({ config: { agentErrorDelayMs: 5 } })
  const session = fakeSession('sess-keep', [])
  ctx.emit('agent/error', { agent: { session }, turn: 2, error: { message: 'dangling failure' } })
  ctx.emit('session/event', session, { type: 'turn/end', seq: 1, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'tool-denied' } } } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(sends.length, 2, 'non-user aborted push + delayed agent-error push both delivered')
  cleanup()
})

test('notify tool: registered with name notify and message parameter', async () => {
  const { registeredTools, cleanup } = await bootPlugin()
  assert.equal(registeredTools.length, 1)
  assert.equal(registeredTools[0].name, 'notify')
  assert.ok(registeredTools[0].parameters.required.includes('message'))
  cleanup()
})

test('resilience: relay 500 on every send still yields ledger failure records', async () => {
  let attempts = 0
  const { ctx, readLedger, cleanup } = await bootPlugin({
    sendImpl: async () => {
      attempts += 1
      return { ok: false, error: 'content is required', httpStatus: 500 }
    },
  })
  const session = fakeSession('sess-g', [])
  ctx.emit('session/event', session, {
    type: 'approval/asked',
    seq: 1,
    data: { id: 'r2', toolName: 'edit', reason: 'write file' },
  })
  await flush()
  assert.ok(attempts >= 1, 'send attempted')
  const lines = readLedger()
  assert.equal(lines.length, 1)
  assert.equal(lines[0].delivered, false)
  assert.match(lines[0].failed[0].error, /content is required/)
  assert.equal(lines[0].failed[0].channel, 'qq-relay')
  cleanup()
})

test('resilience: handler that throws internally does not break subsequent events', async () => {
  const { ctx, sends, cleanup } = await bootPlugin()
  // A session whose snapshotEvents throws — only matters for completed turns;
  // use a poisoned session for approval (no snapshot access) to prove isolation.
  const poisoned = new Proxy(fakeSession('sess-h', []), {
    get (target, prop) {
      if (prop === 'id') return target.id
      if (prop === 'header') throw new Error('header exploded')
      return target[prop]
    },
  })
  ctx.emit('session/event', poisoned, { type: 'approval/asked', seq: 1, data: { id: 'r3', toolName: 'bash' } })
  await flush()
  assert.equal(sends.length, 1, 'approval push unaffected')
  // and the listener is still alive for the next event
  ctx.emit('session/event', fakeSession('sess-h', [assistantEvent(1, 'ok')]), { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  await flush()
  assert.ok(sends.length >= 1)
  cleanup()
})

test('config wiring: events.turnEnd=false silences turn pushes but keeps approval', async () => {
  const { ctx, sends, cleanup } = await bootPlugin({ config: { events: { turnEnd: false } } })
  const session = fakeSession('sess-i', [assistantEvent(1, 'x')])
  ctx.emit('session/event', session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('session/event', session, { type: 'approval/asked', seq: 2, data: { id: 'r4', toolName: 'bash' } })
  await flush()
  assert.equal(sends.length, 1)
  assert.ok(sends[0].content.includes('🔐'))
  cleanup()
})

test('hostile session shapes never crash the pipeline', async () => {
  const { ctx, sends, cleanup } = await bootPlugin()
  ctx.emit('session/event', undefined, undefined)
  // snapshotEvents throwing degrades the excerpt to '' but the completed push
  // still goes out with its fallback text (content non-empty invariant).
  ctx.emit('session/event', { id: 'sess-k', header: { id: 'sess-k' }, snapshotEvents: () => { throw new Error('nope') } }, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
  ctx.emit('session/event', fakeSession('sess-j', []), { type: 'turn/end', seq: 2 }) // missing data entirely
  ctx.emit('session/event', fakeSession('sess-j', []), { type: 'compaction/start', seq: 3, data: {} })
  await flush()
  assert.equal(sends.length, 1, 'only the completed turn pushes (fallback text)')
  assert.ok(sends[0].content.length > 0)
  assert.ok(sends[0].content.includes('任务完成'), 'completed fallback line present')
  cleanup()
})
