/**
 * dsh-gitbash-tool — a model-facing Git Bash tool for DeepSeek Harness on
 * Windows.
 *
 * The tool is intentionally self-contained: it consumes only DSH services
 * (`tools`, `subprocess`, `systemPrompt`, `shellEnv`, `workingDirectory`,
 * `sandboxPolicy`, optional `jobs`) and Node builtins. Git Bash is resolved
 * lazily at call time, so installing the bundle before Git for Windows does
 * not break the Host boot.
 *
 * It also neutralizes the PowerShell-first Windows prompt: the official
 * `pwsh` tool description and its `tool:pwsh` section are rewritten through
 * the public `system-prompt/assemble` waterfall. The `pwsh` tool itself stays
 * available for Windows-native operations.
 */
import { isAbsolute, resolve } from 'node:path'
import {
  GIT_PROVISION_SHA256,
  GIT_PROVISION_URL,
  ensureGitBash,
} from './provision.js'
import {
  GUARD_FAILURE_RULE,
  assertGuard,
  guardedArgv,
  normalizeServerDefaultDacl,
} from './sandbox-guard.js'
import {
  describeGitBashFailure,
} from './git-bash.js'
import {
  GITBASH_SECTION_NAME,
  GITBASH_SECTION_TEXT,
  demotePwshSection,
  demotePwshTool,
  gitBashDescription,
} from './prompt.js'

export const name = 'dsh-gitbash-tool'

/** Services the tool needs. `jobs` is optional and resolved per call. */
export const inject = [
  'tools',
  'subprocess',
  'systemPrompt',
  'shellEnv',
  'workingDirectory',
  'sandboxPolicy',
]

const DEFAULT_TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 600000
const GRACE_MS = 3000
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_SPILL_BYTES = 64 * 1024 * 1024

const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  CHERE_INVOKING: '1',
}

const PARAMETER_DESCRIPTION = 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI).'

/** Convert an MSYS drive path (`/c/Users/...`) into a native Windows path. */
function msysDriveToWindows(value) {
  const match = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(value)
  if (match === null) return value
  const rest = (match[2] ?? '').replace(/\//g, '\\')
  return `${match[1].toUpperCase()}:\\${rest}`
}

/** Resolve a relative per-call workdir against the session directory or policy root. */
function resolveWorkdir(modelWorkdir, sessionCwd, fallback) {
  const base = sessionCwd ?? fallback
  if (modelWorkdir === undefined) return base
  const candidate = modelWorkdir.startsWith('/') ? msysDriveToWindows(modelWorkdir) : modelWorkdir
  if (base !== undefined && !isAbsolute(candidate)) return resolve(base, candidate)
  return candidate
}

function clampTimeout(requested) {
  if (requested === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(requested)}`)
  }
  return Math.min(requested, MAX_TIMEOUT_MS)
}

function validateArgs(args) {
  if (args === null || typeof args !== 'object') throw new Error('invalid arguments: expected an object')
  if (typeof args.command !== 'string' || args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (typeof args.description !== 'string' || args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
}

/** The structured abort the foreground path throws when the caller cancels the call. */
function abortError() {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  error.code = 'ABORTED'
  return error
}

/** A sandbox runner failure is a composition problem, not a command failure. */
function sandboxUnavailableError(mode, detail) {
  const error = new Error(
    `sandbox mode "${mode}" is requested but Git Bash could not run under the Windows file sandbox; refusing to run unconfined. `
    + 'This is a Git for Windows/MSYS limitation. Use pwsh for this command or switch the session to danger-full-access.'
    + (detail === undefined ? '' : ` Runner failure: ${detail}`),
  )
  error.name = 'SandboxUnavailableError'
  error.code = 'SANDBOX_UNAVAILABLE'
  return error
}

function classifyRunnerFailure(exitCode, stderr, rules) {
  if (exitCode === null || exitCode === 0) return undefined
  const lines = String(stderr ?? '').split(/\r?\n/)
  for (const rule of rules ?? []) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
    const informational = new Set((rule.informationalLines ?? []).map((line) => line.toLowerCase()))
    const fatal = (rule.fatalSignatures ?? []).map((line) => line.toLowerCase()).filter((line) => line.length > 0)
    for (const line of lines) {
      const lowered = line.toLowerCase()
      if (informational.has(lowered)) continue
      if (fatal.some((signature) => lowered.includes(signature))) return { detail: line }
    }
  }
  return undefined
}

function matchesSignature(exitCode, stderr, signatures) {
  if (exitCode === null || exitCode === 0) return false
  const lowered = String(stderr ?? '').toLowerCase()
  return (signatures ?? []).some((signature) => lowered.includes(String(signature).toLowerCase()))
}

function streamText(output) {
  if (output === undefined) return ''
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

function renderResult(result) {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  const markers = []
  if (result.sandbox?.runnerFailed) {
    markers.push(`[sandbox: the sandbox runner itself failed under ${result.sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`)
  } else if (result.sandbox?.denied) {
    markers.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
  }
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.stopped !== undefined) markers.push(`[stopped: ${result.stopped}]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  else if (typeof result.exitCode === 'number' && result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)

  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/** The ring chunks of one consuming job read as the shell tools render it. */
function ringDelta(chunks) {
  const out = chunks.filter((chunk) => chunk.channel !== 'stderr').map((chunk) => chunk.text).join('')
  const err = chunks.filter((chunk) => chunk.channel === 'stderr').map((chunk) => chunk.text).join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  return out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
}

/** Shape a foreground call that stopped waiting into the model-facing promoted result. */
function renderPromoted(promoted) {
  return `${promoted.output.length > 0 ? promoted.output.endsWith('\n') ? promoted.output : `${promoted.output}\n` : ''}[still running after ${promoted.timeoutMs}ms; moved to background job ${promoted.jobId}]\nThe command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.`
}

/** Shape a job read's delta, appending loss and sandbox notices. */
function renderJobRead(delta, lossy, spillPaths, sandbox) {
  const notices = []
  if (lossy) {
    notices.push(`[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`)
  }
  if (sandbox?.runnerFailed) {
    notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`)
  } else if (sandbox?.denied) {
    notices.push(`[sandbox: file access denied under ${sandbox.mode} mode]`)
  }
  if (notices.length === 0) return delta
  return `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}

function parseExitStatus(text) {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { body: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { body: text, exitCode: 0 }
}

function finalOutput(reader) {
  if (reader === undefined) return { text: '', truncated: false }
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
  }
}

function makeDeadline(parentSignal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false

  const abortFromParent = () => {
    controller.abort(parentSignal.reason)
  }
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) abortFromParent()
    else parentSignal.addEventListener('abort', abortFromParent, { once: true })
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('gitbash timeout'))
  }, timeoutMs)

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abortFromParent)
    },
  }
}

/** Resolve implementation-owned defaults and caps for one execution. */
function resolveRequest(request) {
  const workdir = request.workdir ?? process.cwd()
  return {
    command: request.command,
    workdir: isAbsolute(workdir) ? workdir : resolve(process.cwd(), workdir),
    timeoutMs: clampTimeout(request.timeoutMs),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
  }
}

/** Map one resolved request and explicit argv onto a subprocess spawn. */
function spawnSpec(spec, argv, signal) {
  const collect = (maxBytes) => ({ maxBytes, spill: { maxBytes: MAX_SPILL_BYTES } })
  return {
    argv,
    cwd: spec.workdir,
    stdio: {
      stdin: 'ignore',
      stdout: collect(MAX_OUTPUT_BYTES),
      stderr: collect(MAX_OUTPUT_BYTES),
    },
    graceMs: GRACE_MS,
    ...(signal !== undefined ? { signal } : {}),
    env: {
      ...ENV_OVERRIDES,
      ...(spec.dshEnv ?? {}),
    },
  }
}

function classifySandboxFacts(outcome, stderrText, facts) {
  if (facts.mode === 'danger-full-access') return { mode: facts.mode, denied: false }
  const runnerFailure = classifyRunnerFailure(outcome.exitCode, stderrText, facts.runnerFailureRules)
  return {
    mode: facts.mode,
    denied: runnerFailure === undefined && matchesSignature(outcome.exitCode, stderrText, facts.denialSignatures),
    ...(facts.enforcement !== undefined ? { enforcement: facts.enforcement } : {}),
    ...(runnerFailure !== undefined ? { runnerFailed: true } : {}),
  }
}

function sandboxNotes(sandbox) {
  if (sandbox?.runnerFailed) {
    return [`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`]
  }
  if (sandbox?.denied) return [`[sandbox: file access denied under ${sandbox.mode} mode]`]
  return []
}

function processOutcome(proc) {
  if (proc.status === 'failed') return { status: 'failed', detail: proc.failure ?? 'spawn failed' }
  const base = proc.status === 'killed'
    ? { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
    : { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
  const notes = sandboxNotes(proc.sandbox)
  return notes.length === 0 ? base : { ...base, detail: `${base.detail}; ${notes.join(' ')}` }
}

function processSources(procRef) {
  const source = (channel) => ({
    channel,
    read: (fromByte) => {
      const live = procRef()
      const reader = live?.handle?.collected?.[channel]
      if (reader === undefined) return { text: '', nextOffset: fromByte, lossy: false }
      return reader.readFrom(fromByte)
    },
  })
  return [source('stdout'), source('stderr')]
}

function canonicalResult(result, cwd) {
  const output = (stream) => ({
    text: stream.text,
    truncated: stream.truncated,
    ...(stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {}),
  })
  return {
    kind: 'foreground',
    cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    ...(result.stopped !== undefined ? { stopped: result.stopped } : {}),
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...(result.sandbox !== undefined ? {
      sandbox: {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...(result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {}),
        ...(result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {}),
      },
    } : {}),
  }
}

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context.
 * @param {{ bashPath?: string, autoInstallGit?: boolean, gitInstallDir?: string, gitDownloadUrl?: string, gitSha256?: string, enableRunInBackground?: boolean, promoteOnTimeout?: boolean, demotePwsh?: boolean }} [config] - row config.
 */
export function apply(ctx, config = {}) {
  if (process.platform !== 'win32') {
    ctx.logger?.info?.('[gitbash] inert on non-Windows hosts')
    return
  }

  const bashPath = typeof config?.bashPath === 'string' ? config.bashPath : ''
  const autoInstallGit = config?.autoInstallGit !== false && process.env.DSH_GITBASH_AUTO_INSTALL !== '0'
  const gitInstallDir = typeof config?.gitInstallDir === 'string' ? config.gitInstallDir : ''
  const gitDownloadUrl = typeof config?.gitDownloadUrl === 'string' && config.gitDownloadUrl.length > 0
    ? config.gitDownloadUrl
    : GIT_PROVISION_URL
  const gitSha256 = typeof config?.gitSha256 === 'string' && config.gitSha256.length > 0
    ? config.gitSha256
    : GIT_PROVISION_SHA256
  const backgroundEnabled = config?.enableRunInBackground !== false
  const promoteOnTimeout = config?.promoteOnTimeout !== false && backgroundEnabled
  const demotePwsh = config?.demotePwsh !== false && process.env.DSH_GITBASH_DEMOTE_PWSH !== '0'

  if (ctx.tools.get('gitbash') !== undefined) {
    ctx.logger?.warn?.('[gitbash] a "gitbash" tool is already registered; leaving it untouched')
    return
  }

  const runForeground = async (request, argv, sandboxFacts) => {
    const spec = resolveRequest(request)
    const deadline = makeDeadline(spec.signal, spec.timeoutMs)
    try {
      let handle
      let outcome
      try {
        handle = ctx.subprocess.spawn(spawnSpec(spec, argv, deadline.signal))
        outcome = await handle.done
      } catch (error) {
        if (sandboxFacts !== undefined && sandboxFacts.mode !== 'danger-full-access') {
          throw sandboxUnavailableError(sandboxFacts.mode, error instanceof Error ? error.message : String(error))
        }
        throw error
      }
      const timedOut = deadline.timedOut()
      const aborted = spec.signal?.aborted === true && !timedOut
      const stdout = finalOutput(handle.collected?.stdout)
      const stderr = finalOutput(handle.collected?.stderr)
      let sandbox
      if (sandboxFacts !== undefined) {
        sandbox = classifySandboxFacts(outcome, stderr.text, sandboxFacts)
        if (sandbox.runnerFailed) throw sandboxUnavailableError(sandbox.mode)
      }
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout,
        stderr,
        ...(sandbox !== undefined ? { sandbox } : {}),
      }
    } finally {
      deadline.dispose()
    }
  }

  const startBackgroundProcess = (request, argv, sandboxFacts) => {
    const spec = resolveRequest(request)
    let handle
    try {
      handle = ctx.subprocess.spawn(spawnSpec(spec, argv, undefined))
    } catch (error) {
      if (sandboxFacts !== undefined && sandboxFacts.mode !== 'danger-full-access') {
        throw sandboxUnavailableError(sandboxFacts.mode, error instanceof Error ? error.message : String(error))
      }
      throw error
    }
    const collected = handle.collected
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      failure: undefined,
      sandbox: undefined,
      stopReason: undefined,
      handle,
    }
    proc.done = handle.done.then((outcome) => {
      if (proc.status === 'running') proc.status = 'completed'
      proc.exitCode = outcome.exitCode
      proc.signal = outcome.signal
      if (sandboxFacts !== undefined) {
        proc.sandbox = classifySandboxFacts(outcome, collected?.stderr?.readFrom(0).text ?? '', sandboxFacts)
      }
    }, (error) => {
      proc.status = 'failed'
      const detail = error instanceof Error ? error.message : String(error)
      proc.failure = sandboxFacts !== undefined && sandboxFacts.mode !== 'danger-full-access'
        ? sandboxUnavailableError(sandboxFacts.mode, detail).message
        : detail
    })
    proc.kill = () => {
      if (proc.status !== 'running') return false
      proc.status = 'killed'
      handle.terminate()
      return true
    }
    proc.result = () => proc.done.then(() => {
      if (proc.status === 'failed') throw new Error(proc.failure ?? 'spawn failed')
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: finalOutput(collected?.stdout),
        stderr: finalOutput(collected?.stderr),
        ...(proc.sandbox !== undefined ? { sandbox: proc.sandbox } : {}),
        ...(proc.stopReason !== undefined ? { stopped: proc.stopReason } : {}),
      }
    })
    return proc
  }

  /** Register one foreground or background command as a generic job. */
  const startJob = (jobs, args, exec, request, argv, sandboxFacts) => {
    let proc
    const id = jobs.start({
      kind: 'gitbash',
      label: args.command,
      toolCall: {
        callId: exec.callId,
        rootCallId: exec.rootCallId,
      },
      ...(exec.agent !== undefined ? { owner: exec.agent.id } : {}),
      output: processSources(() => proc),
      run: () => {
        try {
          proc = startBackgroundProcess(request, argv, sandboxFacts)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return { cancel: () => {}, done: Promise.resolve({ status: 'failed', detail }) }
        }
        return {
          cancel: (reason) => {
            if (proc !== undefined) {
              proc.stopReason = reason
              proc.kill()
            }
          },
          done: proc.done.then(() => processOutcome(proc)),
        }
      },
    })
    return {
      id,
      process: () => proc,
      stopped: () => proc?.stopReason,
    }
  }

  /** Wait on a registered foreground command until it settles or the timeout passes. */
  const waitOnJob = async (jobs, attached, exec, request, sandboxFacts) => {
    const owner = exec.agent?.id
    const spec = resolveRequest({ ...request, signal: exec.signal })
    const timeoutMs = spec.timeoutMs

    const stop = async (reason) => {
      jobs.kill(attached.id, owner, reason)
      const settled = await jobs.wait(attached.id, timeoutMs, owner)
      if (settled.status !== 'running' && settled.status !== 'stopping') jobs.remove(attached.id, owner)
      return settled
    }

    let view
    try {
      view = await jobs.wait(attached.id, timeoutMs, owner, exec.signal)
    } catch {
      await stop('tool call aborted')
      throw abortError()
    }

    if ((view.status === 'running' || view.status === 'stopping') && attached.process() === undefined) {
      await stop('timed out during preparation')
      return {
        kind: 'foreground',
        cwd: spec.workdir,
        exitCode: null,
        signal: null,
        timedOut: true,
        aborted: false,
        timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
        ...(sandboxFacts !== undefined ? { sandbox: { mode: sandboxFacts.mode, denied: false } } : {}),
      }
    }

    if (view.status === 'running' || view.status === 'stopping') {
      const read = jobs.read(attached.id, owner)
      return {
        kind: 'promoted',
        cwd: spec.workdir,
        jobId: attached.id,
        timeoutMs,
        output: renderJobRead(
          ringDelta(read.chunks),
          read.lossy,
          read.job?.output?.spillPaths ?? [],
          attached.process()?.sandbox,
        ),
      }
    }

    jobs.remove(attached.id, owner)
    const process = attached.process()
    if (process === undefined) throw new Error(view.detail)
    const result = await process.result()
    const stopped = attached.stopped()
    return {
      kind: 'foreground',
      cwd: spec.workdir,
      ...canonicalResult(result, spec.workdir),
      ...(stopped !== undefined ? { stopped } : {}),
    }
  }

  const execute = async (args, exec) => {
    validateArgs(args)
    const resolution = await ensureGitBash({
      configured: bashPath,
      autoInstall: autoInstallGit,
      installDir: gitInstallDir,
      archiveUrl: gitDownloadUrl,
      expectedSha256: gitSha256,
      onLog: (message) => ctx.logger?.info?.(`[gitbash] ${message}`),
    })
    if (!resolution.ok) throw new Error(describeGitBashFailure(resolution))
    const bash = resolution.path

    const policyService = ctx.get('sandboxPolicy')
    const policy = policyService?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
    const cwd = exec.agent === undefined
      ? undefined
      : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    const workdir = resolveWorkdir(args.workdir, cwd, policy?.workspaceRoot)
    if (workdir === undefined) throw new Error('gitbash: cannot resolve a working directory for this session')

    let argv = [bash, '-c', args.command]
    let sandboxFacts
    if (policy !== undefined && policy.mode !== 'danger-full-access') {
      const sandbox = ctx.get('sandbox')
      if (sandbox === undefined) throw new Error('gitbash: this session is confined, but ctx.sandbox is missing')
      const guard = assertGuard()
      if (!guard.ok) throw sandboxUnavailableError(policy.mode, guard.reason)
      normalizeServerDefaultDacl((message) => ctx.logger?.warn?.(`[gitbash] ${message}`))
      argv = guardedArgv(bash, args.command)
      const confined = await sandbox.confine(argv, {
        mode: policy.mode,
        workspaceRoot: policy.workspaceRoot,
        ...(policy.sessionId !== undefined ? { sessionId: policy.sessionId } : {}),
      })
      argv = confined.argv
      sandboxFacts = {
        mode: policy.mode,
        enforcement: confined.enforcement,
        denialSignatures: confined.denialSignatures,
        runnerFailureRules: [...(confined.runnerFailureRules ?? []), GUARD_FAILURE_RULE],
      }
    } else if (policy !== undefined) {
      sandboxFacts = { mode: policy.mode }
    }

    const request = {
      command: args.command,
      workdir,
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      dshEnv: ctx.shellEnv.collect(exec),
    }

    if (args.run_in_background === true) {
      if (!backgroundEnabled) throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
      const jobs = ctx.get('jobs')
      if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
      if (exec.signal.aborted) throw abortError()
      const attached = startJob(jobs, args, exec, request, argv, sandboxFacts)
      return { kind: 'background', jobId: attached.id, cwd: workdir }
    }

    const jobs = ctx.get('jobs')
    if (jobs !== undefined && promoteOnTimeout) {
      let attached
      try {
        attached = startJob(jobs, args, exec, request, argv, sandboxFacts)
      } catch (error) {
        ctx.logger?.warn?.(`gitbash: job registration refused, running in the foreground with the timeout kill instead: ${String(error)}`)
      }
      if (attached !== undefined) return waitOnJob(jobs, attached, exec, request, sandboxFacts)
    }

    const result = await runForeground({ ...request, signal: exec.signal }, argv, sandboxFacts)
    if (result.aborted) throw abortError()
    return canonicalResult(result, workdir)
  }

  const parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      description: {
        type: 'string',
        description: PARAMETER_DESCRIPTION,
      },
      command: {
        type: 'string',
        description: 'The Git Bash command to execute. This is Git for Windows Bash (MSYS2), not Linux bash.',
      },
      timeoutMs: {
        type: 'number',
        description: promoteOnTimeout
          ? 'Timeout in milliseconds. On expiry the command moves to the background as a job instead of being killed. Defaults to 120000; capped at 600000.'
          : 'Timeout in milliseconds. The command is killed on expiry. Defaults to 120000; capped at 600000.',
      },
      workdir: {
        type: 'string',
        description: 'Working directory for this command. Use a native Windows path or an MSYS drive path (/c/...); a relative path resolves against the session workspace.',
      },
      ...(backgroundEnabled ? {
        run_in_background: {
          type: 'boolean',
          description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
        },
      } : {}),
    },
    required: ['description', 'command'],
  }

  const outputProperties = {
    kind: { type: 'string', const: 'foreground' },
    cwd: { type: 'string' },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    timedOut: { type: 'boolean' },
    aborted: { type: 'boolean' },
    stopped: { type: 'string' },
    timeoutMs: { type: 'number' },
    stdout: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        spillPath: { type: 'string' },
      },
      required: ['text', 'truncated'],
    },
    stderr: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        spillPath: { type: 'string' },
      },
      required: ['text', 'truncated'],
    },
    sandbox: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string' },
        denied: { type: 'boolean' },
        enforcement: { type: 'string' },
        runnerFailed: { type: 'boolean' },
      },
      required: ['mode', 'denied'],
    },
  }

  const definition = {
    name: 'gitbash',
    description: gitBashDescription({ background: backgroundEnabled, autoInstall: autoInstallGit }),
    parameters,
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'background' },
              jobId: { type: 'string' },
              cwd: { type: 'string' },
              sandbox: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  mode: { type: 'string' },
                  denied: { type: 'boolean' },
                },
                required: ['mode', 'denied'],
              },
            },
            required: ['kind', 'jobId', 'cwd'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'promoted' },
              cwd: { type: 'string' },
              jobId: { type: 'string' },
              timeoutMs: { type: 'number' },
              output: { type: 'string' },
            },
            required: ['kind', 'cwd', 'jobId', 'timeoutMs', 'output'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: outputProperties,
            required: ['kind', 'cwd', 'exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs', 'stdout', 'stderr'],
          },
        ],
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: value.kind === 'background'
            ? `started background job ${value.jobId}`
            : value.kind === 'promoted'
              ? renderPromoted(value)
              : renderResult(value),
        }]
      },
      presentationMeta(_args, value) {
        return value.cwd === undefined ? {} : { cwd: value.cwd }
      },
    },
    execute,
    presentCall(args) {
      if (args?.run_in_background === true) {
        return {
          card: 'generic',
          title: args.command,
          kind: 'execute',
          rawInput: args.command,
          content: [{ type: 'text', text: args.description }],
        }
      }
      return {
        card: 'terminal',
        title: args.command,
        description: args.description,
        ...(args?.workdir !== undefined ? { cwd: args.workdir } : {}),
      }
    },
    presentResult(args, result) {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      const raw = block.text
      const isBackground = args?.run_in_background === true || result.value?.kind === 'background'
      const isPromoted = result.value?.kind === 'promoted'
      if (isBackground || isPromoted || result.isError) {
        return {
          card: 'generic',
          content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }],
        }
      }
      const { body, ...exit } = parseExitStatus(raw)
      return { card: 'terminal', output: body, ...exit }
    },
  }

  ctx.effect(() => ctx.tools.register(definition))

  // Add Git Bash routing next to the official bash tool's placement.
  let sectionOrder = 1000
  try {
    sectionOrder = ctx.systemPrompt.getSectionOrder('TOOL_BASH') ?? sectionOrder
  } catch {
    // A host without the named placement still gets the literal bash order.
  }
  ctx.effect(() => ctx.systemPrompt.section({
    name: GITBASH_SECTION_NAME,
    order: sectionOrder,
    text: GITBASH_SECTION_TEXT,
  }))

  if (demotePwsh) {
    const transform = async (assembly, _context, next) => {
      const result = await next()
      if (result === null || typeof result !== 'object') return result
      return {
        ...result,
        ...(Array.isArray(result.tools) ? { tools: result.tools.map(demotePwshTool) } : {}),
        ...(Array.isArray(result.sections) ? { sections: result.sections.map(demotePwshSection) } : {}),
      }
    }
    ctx.effect(() => ctx.on('system-prompt/assemble', transform))
  }

  ctx.logger?.info?.(`[gitbash] tool active (Git Bash auto-detected at call time; pwsh prompt ${demotePwsh ? 'demoted' : 'left unchanged'})`)
}
