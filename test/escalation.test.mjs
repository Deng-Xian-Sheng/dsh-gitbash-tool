import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ESCALATION_TARGETS,
  approveEscalation,
  isStrictlyWider,
  validateEscalationArgs,
} from '../lib/escalation.js'

test('the escalation ladder is strictly wider only', () => {
  assert.equal(isStrictlyWider('read-only', 'workspace-write'), true)
  assert.equal(isStrictlyWider('read-only', 'danger-full-access'), true)
  assert.equal(isStrictlyWider('workspace-write', 'danger-full-access'), true)
  assert.equal(isStrictlyWider('workspace-write', 'read-only'), false)
  assert.equal(isStrictlyWider('danger-full-access', 'workspace-write'), false)
  assert.equal(isStrictlyWider('danger-full-access', 'danger-full-access'), false)
  assert.deepEqual([...ESCALATION_TARGETS], ['workspace-write', 'danger-full-access'])
})

test('sandbox_permissions and justification must travel together', () => {
  assert.throws(() => validateEscalationArgs('danger-full-access', undefined), /requires a justification/)
  assert.throws(() => validateEscalationArgs(undefined, 'why'), /only valid together/)
  assert.throws(() => validateEscalationArgs('danger-full-access', '   '), /non-empty sentence/)
  assert.doesNotThrow(() => validateEscalationArgs('danger-full-access', 'needed to write outside the workspace'))
})

test('the same mode is returned without asking for approval', async () => {
  let asked = 0
  const result = await approveEscalation({
    requestedMode: 'workspace-write',
    effectiveMode: 'workspace-write',
    justification: 'same mode',
  }, {
    approver: { request: async () => { asked++; return 'allowed-once' } },
    agent: {},
    toolName: 'gitbash',
    callId: 'call-1',
  })
  assert.equal(result, 'workspace-write')
  assert.equal(asked, 0)
})

test('a wider mode goes through approval and returns the granted mode', async () => {
  let captured
  const result = await approveEscalation({
    requestedMode: 'danger-full-access',
    effectiveMode: 'read-only',
    justification: 'need to write outside the read-only workspace',
  }, {
    approver: {
      request: async (request) => {
        captured = request
        return 'allowed-once'
      },
    },
    agent: { id: 'agent-1' },
    toolName: 'gitbash',
    callId: 'call-2',
  })
  assert.equal(result, 'danger-full-access')
  assert.equal(captured.toolName, 'gitbash')
  assert.equal(captured.callId, 'call-2')
  assert.match(captured.reason, /danger-full-access/)
  assert.match(captured.displayReason.zh, /允许本次操作使用 danger-full-access 权限/)
})

test('rejected, cancelled, and unavailable approvals all fail before execution', async () => {
  const expected = {
    rejected: /rejected/,
    cancelled: /cancelled/,
    unavailable: /no approval channel is available/,
  }
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    await assert.rejects(
      () => approveEscalation({
        requestedMode: 'danger-full-access',
        effectiveMode: 'workspace-write',
        justification: 'test',
      }, {
        approver: { request: async () => outcome },
        agent: {},
        toolName: 'gitbash',
        callId: 'call-3',
      }),
      expected[outcome],
    )
  }
})

test('a narrower or unsupported escalation is rejected before approval', async () => {
  let asked = 0
  await assert.rejects(
    () => approveEscalation({
      requestedMode: 'read-only',
      effectiveMode: 'workspace-write',
      justification: 'not wider',
    }, {
      approver: { request: async () => { asked++; return 'allowed-once' } },
      agent: {},
      toolName: 'gitbash',
      callId: 'call-4',
    }),
    /not strictly wider/,
  )
  assert.equal(asked, 0)
})
