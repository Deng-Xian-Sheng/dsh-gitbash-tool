/**
 * Sandbox escalation vocabulary and approval flow.
 *
 * This mirrors the official `@deepseek-ai/dsh-sandbox` escalation contract
 * without importing a host package: the strictly-wider ladder, the
 * `sandbox_permissions`/`justification` pairing, the model-facing parameter
 * text, and an approval sequence that runs BEFORE anything executes.
 *
 * A tool schema cannot encode "strictly wider than this call's current mode",
 * so the schema advertises the closed target vocabulary and this module checks
 * the live effective mode at execution time.
 */

/** The strictly-wider ladder. */
export const WIDER_MODES = Object.freeze({
  'read-only': Object.freeze(['workspace-write', 'danger-full-access']),
  'workspace-write': Object.freeze(['danger-full-access']),
})

/** The closed escalation-target vocabulary advertised in the tool schema. */
export const ESCALATION_TARGETS = Object.freeze(['workspace-write', 'danger-full-access'])

/** Validate the `sandbox_permissions` / `justification` pairing. */
export function validateEscalationArgs(sandboxPermissions, justification) {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
}

/** Whether `requestedMode` is strictly wider than `effectiveMode`. */
export function isStrictlyWider(effectiveMode, requestedMode) {
  return (WIDER_MODES[effectiveMode] ?? []).includes(requestedMode)
}

/** The model-facing parameter description for `sandbox_permissions`. */
export function sandboxPermissionsDescription(subject = 'command') {
  return `The narrowest wider sandbox mode for a one-shot retry of the exact ${subject} the sandbox just denied; the retry asks the user for approval.`
}

/**
 * Resolve one escalation request through the approval channel.
 *
 * Repeating the call's effective mode returns it without approval. A strictly
 * wider mode requires approval and applies only to this call. Narrower or
 * unsupported targets, missing approval services or agents for widening, and
 * non-grant outcomes throw before execution.
 *
 * @param {object} request
 * @param {'read-only'|'workspace-write'|'danger-full-access'} request.requestedMode
 * @param {'read-only'|'workspace-write'|'danger-full-access'} request.effectiveMode
 * @param {string} request.justification
 * @param {string} [request.subject]
 * @param {object} approval
 * @param {object|undefined} approval.approver - the approval service.
 * @param {object|undefined} approval.agent - the calling agent.
 * @param {string} approval.toolName
 * @param {string} approval.callId
 * @param {AbortSignal} [approval.signal]
 * @returns {Promise<'read-only'|'workspace-write'|'danger-full-access'>} the granted mode.
 */
export async function approveEscalation(request, approval) {
  const { requestedMode, effectiveMode, justification, subject = 'command' } = request
  if (requestedMode === effectiveMode) return effectiveMode
  if (!isStrictlyWider(effectiveMode, requestedMode)) {
    throw new Error(`sandbox escalation to "${requestedMode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
  }
  if (approval.approver === undefined) {
    throw new Error(`sandbox escalation to "${requestedMode}" requires approval, but no approval service is composed`)
  }
  if (approval.agent === undefined) {
    throw new Error(`sandbox escalation to "${requestedMode}" requires approval, but the call has no agent to route it through`)
  }

  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: approval.toolName,
    callId: approval.callId,
    reason: `escalate sandbox to ${requestedMode}: ${justification}`,
    displayReason: {
      en: `Allow this operation with ${requestedMode} permissions: ${justification}`,
      zh: `允许本次操作使用 ${requestedMode} 权限：${justification}`,
    },
    ...(approval.signal !== undefined ? { signal: approval.signal } : {}),
  })

  switch (outcome) {
    case 'allowed-once': return requestedMode
    case 'rejected':
      throw new Error(`the user rejected escalating this ${subject} to "${requestedMode}"; it stays denied, so stop and explain instead of working around it`)
    case 'cancelled':
      throw new Error(`approval for escalating to "${requestedMode}" was cancelled`)
    case 'unavailable':
      throw new Error(`sandbox escalation to "${requestedMode}" requires approval, but no approval channel is available`)
    default:
      throw new Error(`unknown approval outcome: ${String(outcome)}`)
  }
}
