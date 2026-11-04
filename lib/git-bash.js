/**
 * Git for Windows Bash discovery and verification.
 *
 * This module has no dependency on the DSH runtime, so it can be unit-tested
 * with plain Node. The plugin resolves Git Bash lazily, at tool-call time, so
 * installing the plugin before Git for Windows does not break the Host boot.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Official download page shown in the failure message. */
export const GIT_BASH_INSTALL_URL = 'https://git-scm.com/download/win'

const BASH_BASENAME = 'bash.exe'

/** Read an environment key case-insensitively (Windows environment keys are case-insensitive). */
function envValue(env, name) {
  if (env === undefined || env === null) return undefined
  if (typeof env[name] === 'string' && env[name].length > 0) return env[name]
  const wanted = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted && typeof env[key] === 'string' && env[key].length > 0) return env[key]
  }
  return undefined
}

/** Expand `~`, surrounding quotes, and relative configured values. */
export function expandBashPath(value, env = process.env) {
  let text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) return ''
  text = text.replace(/^["']|["']$/g, '')
  const home = envValue(env, 'USERPROFILE') ?? homedir()
  if (text === '~') return home
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(home, text.slice(2))
  return resolve(text)
}

/** A WSL launcher must never be mistaken for Git Bash, even when it is named bash.exe. */
export function isWslOrForeignBash(path) {
  const lower = String(path).toLowerCase()
  const systemRoot = (envValue(process.env, 'SystemRoot') ?? 'C:\\Windows').toLowerCase()
  return lower.startsWith(systemRoot + '\\system32\\bash.exe')
    || lower.includes('\\windowsapps\\')
    || lower.includes('\\system32\\bash.exe')
}

/** Verify that a candidate is a real Git for Windows Bash by running it. */
export function verifyGitBash(path, { env = process.env, timeout = 5000 } = {}) {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return { ok: false, reason: 'not a file' }
    if (isWslOrForeignBash(path)) return { ok: false, reason: 'WSL/WindowsApps launcher is not Git Bash' }
    const output = execFileSync(path, ['-c', 'uname -s'], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      env: { ...env },
    })
    const system = String(output).trim()
    if (/^(MINGW|MSYS)/i.test(system)) return { ok: true, path, system }
    return { ok: false, reason: `uname -s returned ${JSON.stringify(system)}; expected MINGW*/MSYS*` }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `could not run bash.exe: ${detail}` }
  }
}

/** Standard Git for Windows install roots plus PATH entries, in priority order. */
export function candidateBashPaths(env = process.env) {
  const seen = new Set()
  const out = []
  const add = (value) => {
    if (typeof value !== 'string' || value.length === 0) return
    const key = value.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(value)
  }

  const programFiles = envValue(env, 'ProgramFiles') ?? 'C:\\Program Files'
  const programFilesX86 = envValue(env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)'
  const programW6432 = envValue(env, 'ProgramW6432') ?? programFiles
  const localAppData = envValue(env, 'LOCALAPPDATA')
    ?? (envValue(env, 'USERPROFILE') !== undefined ? join(envValue(env, 'USERPROFILE'), 'AppData', 'Local') : undefined)
  const userProfile = envValue(env, 'USERPROFILE')
  const scoopRoot = envValue(env, 'SCOOP') ?? (userProfile !== undefined ? join(userProfile, 'scoop') : undefined)
  const systemRoot = (envValue(env, 'SystemRoot') ?? 'C:\\Windows').toLowerCase()

  for (const root of [programFiles, programFilesX86, programW6432]) {
    add(join(root, 'Git', 'bin', BASH_BASENAME))
    add(join(root, 'Git', 'usr', 'bin', BASH_BASENAME))
  }
  if (localAppData !== undefined) add(join(localAppData, 'Programs', 'Git', 'bin', BASH_BASENAME))
  if (scoopRoot !== undefined) add(join(scoopRoot, 'apps', 'git', 'current', 'bin', BASH_BASENAME))

  const path = envValue(env, 'PATH') ?? ''
  for (const entry of path.split(';')) {
    const directory = entry.trim().replace(/^"|"$/g, '')
    if (directory.length === 0) continue
    const lower = directory.toLowerCase()
    if (lower.startsWith(systemRoot) || lower.includes('\\windowsapps\\')) continue
    add(join(directory, BASH_BASENAME))
  }
  return out
}

/** Candidate Git roots derived from `git.exe --exec-path` on PATH. */
export function gitExecPathBashPaths(env = process.env) {
  const out = []
  const path = envValue(env, 'PATH') ?? ''
  for (const entry of path.split(';')) {
    const directory = entry.trim().replace(/^"|"$/g, '')
    if (directory.length === 0) continue
    const git = join(directory, 'git.exe')
    if (!existsSync(git)) continue
    try {
      const execPath = String(execFileSync(git, ['--exec-path'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        env: { ...env },
      })).trim()
      if (execPath.length === 0) continue
      // <root>/<mingw64|ucrt64>/libexec/git-core -> <root>
      const root = resolve(execPath, '..', '..', '..')
      out.push(join(root, 'bin', BASH_BASENAME), join(root, 'usr', 'bin', BASH_BASENAME))
    } catch {
      // A broken shim is not a candidate; continue with the next PATH entry.
    }
  }
  return out
}

/** Candidate install roots from the Git for Windows registry entries. */
export function registryBashPaths(env = process.env) {
  const out = []
  for (const key of ['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows']) {
    try {
      const text = String(execFileSync('reg.exe', ['query', key, '/v', 'InstallPath'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        env: { ...env },
      }))
      const match = /InstallPath\s+REG_SZ\s+(.+?)\s*$/im.exec(text)
      if (match?.[1] !== undefined) {
        const root = match[1].replace(/[\\/]+$/, '')
        out.push(join(root, 'bin', BASH_BASENAME), join(root, 'usr', 'bin', BASH_BASENAME))
      }
    } catch {
      // Missing key is the normal case on machines without a machine-wide Git install.
    }
  }
  return out
}

/**
 * Resolve a usable Git for Windows Bash.
 *
 * Explicit configuration wins over the environment; both are validated and
 * never silently replaced by another shell. Automatic detection checks the
 * standard install roots, PATH, `git --exec-path`, and the Git for Windows
 * registry key. WSL launchers and non-MSYS bash builds are rejected.
 *
 * @returns {{ ok: true, path: string, source: string, system: string, checked: string[] }
 *   | { ok: false, reason: string, checked: string[] }}
 */
export function resolveGitBash({ configured = '', env = process.env } = {}) {
  const checked = []
  const seen = new Set()
  const check = (candidate, source) => {
    if (typeof candidate !== 'string' || candidate.length === 0) return undefined
    const key = candidate.toLowerCase()
    if (seen.has(key)) return undefined
    seen.add(key)
    checked.push(candidate)
    const verdict = verifyGitBash(candidate, { env })
    return verdict.ok ? { ok: true, path: candidate, source, system: verdict.system, checked } : undefined
  }

  const configuredPath = expandBashPath(configured, env)
  if (configuredPath.length > 0) {
    const result = check(configuredPath, 'config')
    if (result !== undefined) return result
    return { ok: false, reason: `configured bashPath is not a usable Git for Windows bash: ${configuredPath}`, checked }
  }

  const envPath = expandBashPath(envValue(env, 'DSH_GIT_BASH_PATH') ?? '', env)
  if (envPath.length > 0) {
    const result = check(envPath, 'env')
    if (result !== undefined) return result
    return { ok: false, reason: `DSH_GIT_BASH_PATH is not a usable Git for Windows bash: ${envPath}`, checked }
  }

  for (const candidate of candidateBashPaths(env)) {
    const result = check(candidate, 'auto')
    if (result !== undefined) return result
  }
  for (const candidate of gitExecPathBashPaths(env)) {
    const result = check(candidate, 'git')
    if (result !== undefined) return result
  }
  for (const candidate of registryBashPaths(env)) {
    const result = check(candidate, 'registry')
    if (result !== undefined) return result
  }

  return {
    ok: false,
    reason: 'no usable Git for Windows bash.exe was found',
    checked,
  }
}

/** Model-facing failure text with install and configuration guidance. */
export function describeGitBashFailure(resolution) {
  const lines = [
    'gitbash: Git for Windows Bash is required but was not found or is not usable.',
    `Install Git for Windows: ${GIT_BASH_INSTALL_URL}`,
    'Or set DSH_GIT_BASH_PATH, or configure the plugin row with bashPath pointing at Git\\bin\\bash.exe.',
  ]
  if (resolution?.reason !== undefined) lines.push(`Reason: ${resolution.reason}`)
  if (Array.isArray(resolution?.checked) && resolution.checked.length > 0) {
    lines.push(`Checked: ${resolution.checked.join(', ')}`)
  }
  lines.push('WSL, WindowsApps, and non-MSYS bash builds are intentionally rejected.')
  return lines.join('\n')
}
