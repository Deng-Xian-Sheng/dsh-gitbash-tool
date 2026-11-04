/**
 * Windows ACL + MSYS bridge.
 *
 * Git for Windows is an MSYS2/Cygwin runtime. Under DSH's Windows ACL
 * restricted token, a plain `bash.exe` frequently cannot initialize its signal
 * pipes. The vendored MSYS token guard starts the same `bash.exe` after
 * preparing the restricted child token, leaving the ACL runner's write
 * boundary intact.
 *
 * The binary is optional at the Node level so the module can be imported on
 * non-Windows hosts; callers on Windows check {@link assertGuard} before using
 * a confined execution.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const GUARD_EXECUTABLE = resolve(PACKAGE_ROOT, 'native', 'bin', 'win32-x64', 'msys-token-guard.exe')
export const GUARD_HOOK = resolve(PACKAGE_ROOT, 'native', 'bin', 'win32-x64', 'msys-token-guard-hook.dll')

/** The guard's machine-readable failure dialect. */
export const GUARD_FAILURE_RULE = {
  allowedExitCodes: [125],
  fatalSignatures: ['msys-token-guard:'],
}

let normalized = false

/**
 * Check that both guard artifacts are readable files.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function assertGuard() {
  for (const artifact of [GUARD_EXECUTABLE, GUARD_HOOK]) {
    try {
      if (!statSync(artifact).isFile()) return { ok: false, reason: `not a file: ${artifact}` }
      accessSync(artifact, constants.R_OK)
    } catch (error) {
      return { ok: false, reason: `native guard artifact unavailable: ${artifact} (${String(error)})` }
    }
  }
  return { ok: true }
}

/**
 * Run the guard's one-shot server-DACL normalization, at most once per process.
 *
 * DSH derives restricted tokens from the server process token. Servers started
 * outside MSYS2 can carry a default DACL without the user SID, which makes the
 * guard's child-token setup fail (exit 125). The upstream plugin normalizes it
 * once per server process; this is the same call. The helper does not grant
 * the command additional filesystem access.
 *
 * @param {(message: string) => void} [log] - optional diagnostic sink.
 * @returns {boolean} whether the helper reported success.
 */
export function normalizeServerDefaultDacl(log = () => {}) {
  if (normalized) return true
  normalized = true
  if (process.platform !== 'win32' || process.arch !== 'x64') return false
  try {
    execFileSync(GUARD_EXECUTABLE, ['--normalize-server-dacl'], {
      timeout: 10000,
      windowsHide: true,
      stdio: 'ignore',
    })
    return true
  } catch (error) {
    log(`native guard DACL normalization failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Build the argv that runs one Git Bash command through the guard.
 * @param {string} bashPath - resolved Git for Windows `bash.exe`.
 * @param {string} command - shell command.
 * @returns {string[]} guard argv.
 */
export function guardedArgv(bashPath, command) {
  return [GUARD_EXECUTABLE, '--', bashPath, '-c', command]
}
