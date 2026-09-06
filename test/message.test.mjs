/**
 * Tests for dsh-qq-notify message assembly.
 * The critical invariant: relay payload `content` is NEVER empty.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clip,
  ensureNonEmpty,
  buildApprovalBody,
  buildAskUserBody,
  buildAgentErrorBody,
  buildTurnEndBody,
  turnEndKindLabel,
  lastAssistantExcerpt,
  buildRelayPayload,
} from '../src/message.mjs'

const PLACEHOLDER = '(通知内容为空)'

// ---- ensureNonEmpty / buildRelayPayload ---------------------------------

test('ensureNonEmpty: empty body falls back to title', () => {
  assert.equal(ensureNonEmpty('', '标题'), '标题')
  assert.equal(ensureNonEmpty('   ', '标题'), '标题')
  assert.equal(ensureNonEmpty(undefined, '标题'), '标题')
})

test('ensureNonEmpty: empty body and title falls back to placeholder', () => {
  assert.equal(ensureNonEmpty('', ''), PLACEHOLDER)
  assert.equal(ensureNonEmpty(undefined, undefined), PLACEHOLDER)
  assert.equal(ensureNonEmpty('', null), PLACEHOLDER)
})

test('buildRelayPayload: content never empty across hostile inputs', () => {
  for (const content of ['', '   ', null, undefined, 42, {}, []]) {
    const payload = buildRelayPayload('OID', content)
    assert.equal(typeof payload.content, 'string')
    assert.ok(payload.content.length > 0, `content must be non-empty for ${JSON.stringify(content)}`)
  }
})

test('buildRelayPayload: carries openid and drops it when empty', () => {
  assert.equal(buildRelayPayload('OID123', 'hi').openid, 'OID123')
  assert.equal('openid' in buildRelayPayload('', 'hi'), false)
})

test('buildRelayPayload: good content passes through unchanged', () => {
  assert.deepEqual(buildRelayPayload('OID', '## Hello'), { openid: 'OID', content: '## Hello' })
})

// ---- clip ----------------------------------------------------------------

test('clip: short strings pass through', () => {
  assert.equal(clip('abc', 10), 'abc')
})

test('clip: long strings truncate with ellipsis', () => {
  const out = clip('x'.repeat(600), 500)
  assert.equal(out.length, 500)
  assert.ok(out.endsWith('…'))
})

test('clip: non-string input yields empty string', () => {
  assert.equal(clip(undefined, 10), '')
})

// ---- turn/end mapping ------------------------------------------------------

test('turnEndKindLabel: known kinds map to expected emoji/label', () => {
  assert.deepEqual(turnEndKindLabel('completed'), { emoji: '✅', label: '任务完成' })
  assert.deepEqual(turnEndKindLabel('error'), { emoji: '❌', label: '任务出错' })
  assert.deepEqual(turnEndKindLabel('blocked'), { emoji: '⛔', label: '任务受阻' })
  assert.deepEqual(turnEndKindLabel('aborted'), { emoji: '⏹', label: '已中止' })
  assert.deepEqual(turnEndKindLabel('max-tokens'), { emoji: '🔢', label: '达到 token 上限' })
  assert.deepEqual(turnEndKindLabel('interrupted'), { emoji: '⏸', label: '已被打断' })
})

test('turnEndKindLabel: unknown kinds return undefined (silently ignored)', () => {
  assert.equal(turnEndKindLabel('warp-drive'), undefined)
  assert.equal(turnEndKindLabel(undefined), undefined)
})

test('buildTurnEndBody: completed is minimal — excerpt with context, no headline/turn/quote', () => {
  const body = buildTurnEndBody(
    { turn: 3, reason: { kind: 'completed' } },
    '这是最后一条助手消息',
    { serverName: 'my-server', workspaceName: 'my-project' },
  )
  assert.ok(body.includes('这是最后一条助手消息'))
  assert.ok(body.includes('服务器：my-server · 工作区：my-project'))
  assert.equal(body.includes('✅'), false, 'no headline for completed')
  assert.equal(body.includes('turn 3'), false, 'no turn line for completed')
  assert.equal(body.includes('>'), false, 'no quote block for completed')
})

test('buildTurnEndBody: completed without excerpt keeps a non-empty fallback', () => {
  const body = buildTurnEndBody({ turn: 1, reason: { kind: 'completed' } }, '', { serverName: 's' })
  assert.ok(body.length > 0)
  assert.ok(body.includes('任务完成'))
})

test('buildTurnEndBody: completed without any context is just the excerpt', () => {
  const body = buildTurnEndBody({ turn: 1, reason: { kind: 'completed' } }, 'done text', undefined)
  assert.equal(body, 'done text')
})

test('buildTurnEndBody: error kind includes provider error message', () => {
  const body = buildTurnEndBody({ turn: 2, reason: { kind: 'error', error: { message: 'boom', code: 'X' } } }, '')
  assert.ok(body.includes('❌'))
  assert.ok(body.includes('boom'))
})

test('buildTurnEndBody: unknown kind returns undefined', () => {
  assert.equal(buildTurnEndBody({ turn: 1, reason: { kind: 'warp-drive' } }, 'text'), undefined)
})

test('buildTurnEndBody: missing excerpt still produces a body', () => {
  const body = buildTurnEndBody({ turn: 1, reason: { kind: 'aborted', reason: 'user' } }, '')
  assert.ok(body.includes('⏹'))
})

// ---- approval / ask-user / agent-error -------------------------------------

test('buildApprovalBody: includes tool name and reason', () => {
  const body = buildApprovalBody({ id: 'r1', toolName: 'bash', reason: 'runs rm -rf' })
  assert.ok(body.includes('🔐'))
  assert.ok(body.includes('`bash`'))
  assert.ok(body.includes('runs rm -rf'))
})

test('buildApprovalBody: missing fields never crash and never yield empty', () => {
  const body = buildApprovalBody(undefined)
  assert.ok(body.includes('未知工具'))
  assert.ok(body.trim().length > 0)
})

test('buildAskUserBody: lists questions with headers', () => {
  const body = buildAskUserBody([
    { id: 'q1', header: '确认', question: '继续执行吗？' },
    { id: 'q2', question: '无 header 的问题' },
  ])
  assert.ok(body.includes('💬'))
  assert.ok(body.includes('[确认] 继续执行吗？'))
  assert.ok(body.includes('无 header 的问题'))
})

test('buildAskUserBody: empty/missing questions still non-empty', () => {
  assert.ok(buildAskUserBody([]).includes('问题内容缺失'))
  assert.ok(buildAskUserBody(undefined).trim().length > 0)
})

test('buildAgentErrorBody: includes message and turn', () => {
  const body = buildAgentErrorBody({ turn: 7, error: { message: 'socket hang up' } })
  assert.ok(body.includes('🔥'))
  assert.ok(body.includes('turn 7'))
  assert.ok(body.includes('socket hang up'))
})

// ---- lastAssistantExcerpt ----------------------------------------------------

function assistantMessage (text) {
  return { type: 'assistant/message', seq: 99, data: { message: { content: [{ type: 'text', text }] } } }
}

test('lastAssistantExcerpt: scans tail-first and returns last assistant text', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
    assistantMessage('第一条'),
    { type: 'tool/call', data: {} },
    assistantMessage('第二条 最终回复'),
  ]
  assert.equal(lastAssistantExcerpt(events, 500), '第二条 最终回复')
})

test('lastAssistantExcerpt: joins multiple text blocks with newline', () => {
  const events = [
    { type: 'assistant/message', data: { message: { content: [
      { type: 'text', text: 'A' },
      { type: 'reasoning', text: 'secret thinking' },
      { type: 'text', text: 'B' },
    ] } } },
  ]
  assert.equal(lastAssistantExcerpt(events, 500), 'A\nB')
})

test('lastAssistantExcerpt: skips non-text-only assistant messages to find text', () => {
  const events = [
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'x' }] } } },
    assistantMessage('真正的文本'),
  ]
  assert.equal(lastAssistantExcerpt(events, 500), '真正的文本')
})

test('lastAssistantExcerpt: no assistant text yields empty string', () => {
  assert.equal(lastAssistantExcerpt([], 500), '')
  assert.equal(lastAssistantExcerpt(undefined, 500), '')
  assert.equal(lastAssistantExcerpt([{ type: 'user/message', data: {} }], 500), '')
})

test('lastAssistantExcerpt: respects maxChars', () => {
  const events = [assistantMessage('y'.repeat(1000))]
  const out = lastAssistantExcerpt(events, 500)
  assert.equal(out.length, 500)
})
