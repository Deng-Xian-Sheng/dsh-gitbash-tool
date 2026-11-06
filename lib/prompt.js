/**
 * Model-facing text for the Git Bash tool and the PowerShell routing helpers.
 *
 * Kept free of runtime imports so the strings can be unit-tested directly.
 */

/** System-prompt section name; it sits at the bash section's order. */
export const GITBASH_SECTION_NAME = 'tool:gitbash'

/**
 * Routing guidance added by the plugin. The PowerShell tool remains available
 * for Windows-native work, but it must no longer read as the default shell.
 */
export const GITBASH_SECTION_TEXT = [
  'Shell routing: `gitbash` is Git for Windows Bash (MSYS2), not Linux bash.',
  'Prefer it for shell syntax, scripts, pipelines, redirection, file work, and POSIX utilities.',
  'Use the `pwsh` tool, when offered, only for Windows-native operations that Git Bash cannot perform (PowerShell cmdlets, registry, services, WMI, .NET).',
  'Fix Git Bash syntax in Git Bash; do not wrap a command in `pwsh -Command` as a workaround.',
  'If the sandbox denies a command, retry the exact command once with `sandbox_permissions` + `justification` when those fields are offered; the approval prompt asks the user. Do not use `pwsh` as a workaround for a sandbox denial.',
  'Check the `[exit code: N]` marker on every result and investigate failures before moving on.',
].join(' ')

/**
 * Routing prefix prepended to the official `pwsh` tool description. The
 * original description — including PowerShell syntax and examples — is kept
 * intact after this prefix: it remains useful when Git Bash cannot do a
 * Windows-native operation.
 */
export const PWSH_ROUTING_PREFIX = [
  'PowerShell is not the default shell on this Windows host.',
  'Use the `gitbash` tool for ordinary shell work; use this PowerShell tool only for Windows-native operations that Git Bash cannot perform.',
  'The PowerShell syntax reference below is retained for those cases.',
].join(' ')

/** Routing prefix prepended to the official `tool:pwsh` section. */
export const PWSH_SECTION_ROUTING_PREFIX = [
  'Prefer `gitbash` for shell work.',
  'Use this PowerShell section for Windows-native operations that Git Bash cannot perform; its result guidance follows.',
].join(' ')

/**
 * Build the gitbash tool description.
 * @param {{ background?: boolean, autoInstall?: boolean, escalation?: boolean }} [options] - whether background jobs, automatic Git install, and sandbox escalation are offered.
 * @returns {string} the model-facing description.
 */
export function gitBashDescription({ background = true, autoInstall = false, escalation = false } = {}) {
  const parts = [
    'Execute a Git Bash command (`bash.exe -c`) on Windows and return its stdout/stderr.',
    'This is Git for Windows Bash (MSYS2), not Linux bash: paths accept native Windows form (`C:\\...`) and MSYS drive form (`/c/...`); managed `$DSH_*` variables expose harness facts; only tools shipped with Git for Windows are available.',
    'Each call runs a fresh shell, so cwd, variables, and functions do not persist; pass `workdir` instead of using `cd`.',
    'Prefer this tool for shell syntax, scripts, pipelines, redirection, file work, and POSIX utilities; use `pwsh` only for Windows-native operations that Git Bash cannot perform.',
    'Git Bash converts path-like arguments when invoking native Windows programs (for example `cmd /c` and `ipconfig /all` may break); use `//c`, `//all`, or `MSYS2_ARG_CONV_EXCL` where needed. Native Windows programs may emit non-UTF-8 bytes; prefer Git Bash tools or request UTF-8 output explicitly.',
    'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available.',
    'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a command bug; do not retry another way. On Windows, confined Git Bash runs through a bundled MSYS token guard; if the guard reports `SANDBOX_UNAVAILABLE`, the command did not run — report that to the user instead of silently switching tools.',
    'Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. An unset variable expands to an empty string, so guard variables in such paths with `${VAR:?}`.',
  ]
  if (autoInstall) {
    parts.push('If Git for Windows is missing, the first call downloads a pinned PortableGit (about 60 MB, SHA-256 verified) into the user\'s local app data and uses that private install; no administrator rights are required.')
  }
  if (escalation) {
    parts.push('If a command is denied by the sandbox and a wider mode would let the exact command succeed, retry that same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`; the approval prompt asks the user. Do not escalate speculatively, and do not switch to `pwsh` merely because of a sandbox denial.')
  }
  if (background) {
    parts.push('Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.')
  } else {
    parts.push('Background execution is not available; long-running commands must finish within the timeout.')
  }
  return parts.join(' ')
}

/**
 * Prepend Git Bash routing to the official pwsh tool schema without removing
 * any PowerShell syntax or examples.
 *
 * The function is pure: it never mutates the input object.
 * @param {object} tool - one assembled tool schema.
 * @returns {object} the original tool, or a routed clone.
 */
export function demotePwshTool(tool) {
  if (tool === null || typeof tool !== 'object' || tool.name !== 'pwsh') return tool
  if (typeof tool.description !== 'string' || tool.description.startsWith(PWSH_ROUTING_PREFIX)) return tool
  return { ...tool, description: `${PWSH_ROUTING_PREFIX}\n\n${tool.description}` }
}

/**
 * Prepend Git Bash routing to the PowerShell section while preserving its
 * original result guidance.
 * @param {object} section - one assembled prompt section.
 * @returns {object} the original section, or a routed clone.
 */
export function demotePwshSection(section) {
  if (section === null || typeof section !== 'object' || section.name !== 'tool:pwsh') return section
  if (typeof section.text !== 'string' || section.text.startsWith(PWSH_SECTION_ROUTING_PREFIX)) return section
  return { ...section, text: `${PWSH_SECTION_ROUTING_PREFIX}\n\n${section.text}` }
}
