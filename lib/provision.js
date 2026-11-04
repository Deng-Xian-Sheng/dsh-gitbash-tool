/**
 * First-use Git for Windows provisioning.
 *
 * The plugin targets Windows users who may not have a development environment,
 * so "Git is missing" must not mean "the tool cannot work". The default is to
 * download a pinned Git for Windows PortableGit archive, verify its SHA-256,
 * extract it into a private per-user directory, and use that `bash.exe`.
 *
 * Nothing is downloaded when a usable Git Bash is already present, when the
 * user explicitly configured `bashPath` / `DSH_GIT_BASH_PATH`, or when
 * `autoInstallGit` is false. The archive is never executed with arguments other
 * than the 7-Zip extraction options needed to unpack it.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import {
  GIT_BASH_INSTALL_URL,
  envValue,
  expandBashPath,
  resolveGitBash,
  verifyGitBash,
} from './git-bash.js'

/** Pinned Git for Windows release used by automatic provisioning. */
export const GIT_PROVISION_VERSION = '2.56.0.4'
export const GIT_PROVISION_URL = 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe'
export const GIT_PROVISION_SHA256 = 'b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1'

const ARCHIVE_NAME = 'PortableGit.7z.exe'
const CURRENT_MARKER = 'current.txt'

let provisioning = null
let lastProvisioned = ''

/** Root that holds private PortableGit installs, under the user's local app data. */
export function defaultInstallRoot(env = process.env) {
  const localAppData = envValue(env, 'LOCALAPPDATA')
  if (localAppData !== undefined) return join(localAppData, 'dsh-gitbash-tool', 'git')
  return join(homedir(), 'AppData', 'Local', 'dsh-gitbash-tool', 'git')
}

/** Read the path recorded by a previous successful provision. */
export function provisionedBashPath(env = process.env) {
  try {
    const marker = join(defaultInstallRoot(env), CURRENT_MARKER)
    const path = readFileSync(marker, 'utf8').trim()
    return path.length > 0 ? path : ''
  } catch {
    return ''
  }
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function downloadArchive(url, target, { expectedSha256, timeoutMs, onLog }) {
  if (!/^https:\/\//i.test(url)) throw new Error(`refusing non-HTTPS Git download URL: ${url}`)
  onLog?.(`downloading Git for Windows PortableGit from ${url}`)
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'dsh-gitbash-tool/0.1' },
  })
  if (!response.ok || response.body === null) {
    throw new Error(`Git download failed: HTTP ${response.status} ${response.statusText}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target))
  const digest = await sha256File(target)
  if (expectedSha256.length > 0 && digest.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(`Git download SHA-256 mismatch: expected ${expectedSha256}, got ${digest}`)
  }
  onLog?.(`downloaded ${(statSync(target).size / (1024 * 1024)).toFixed(1)} MiB; SHA-256 verified`)
}

function removeOurDirectory(directory, installDir) {
  const resolved = resolve(directory)
  const root = resolve(installDir)
  const prefix = root.endsWith('\\') || root.endsWith('/') ? root : `${root}\\`
  if (!resolved.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new Error(`refusing to remove directory outside the install root: ${resolved}`)
  }
  rmSync(resolved, { recursive: true, force: true })
}

/**
 * Extract one already-downloaded PortableGit archive and verify the resulting
 * `bash.exe`. Exported separately so tests can exercise extraction without a
 * network round trip.
 *
 * @param {string} archivePath - local PortableGit `.7z.exe`.
 * @param {{ installDir?: string, version?: string, expectedSha256?: string, verifyHash?: boolean, onLog?: (message: string) => void }} [options]
 * @returns {Promise<{ ok: true, path: string, installed: boolean, system: string }>}
 */
export async function provisionFromArchive(archivePath, {
  installDir = defaultInstallRoot(),
  version = GIT_PROVISION_VERSION,
  expectedSha256 = GIT_PROVISION_SHA256,
  verifyHash = true,
  onLog = () => {},
} = {}) {
  if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
    throw new Error(`PortableGit archive is missing: ${archivePath}`)
  }
  if (!isAbsolute(installDir)) throw new Error(`gitInstallDir must be absolute: ${installDir}`)

  const finalDir = join(installDir, `PortableGit-${version}`)
  const finalBash = join(finalDir, 'bin', 'bash.exe')
  if (existsSync(finalBash)) {
    const existing = verifyGitBash(finalBash)
    if (existing.ok) {
      writeFileSync(join(installDir, CURRENT_MARKER), `${finalBash}\n`, 'utf8')
      return { ok: true, path: finalBash, installed: false, system: existing.system }
    }
  }

  if (verifyHash && expectedSha256.length > 0) {
    const digest = await sha256File(archivePath)
    if (digest.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(`PortableGit archive SHA-256 mismatch: expected ${expectedSha256}, got ${digest}`)
    }
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), 'dsh-gitbash-install-'))
  const staging = join(stagingRoot, 'git')
  try {
    mkdirSync(staging, { recursive: true })
    onLog?.('extracting PortableGit (this may take a minute)...')
    // PortableGit is a 7-Zip self-extracting archive; -o/-y unpack silently.
    execFileSync(archivePath, [`-o${staging}`, '-y'], {
      timeout: 180000,
      windowsHide: true,
      stdio: 'ignore',
    })
    const stagedBash = join(staging, 'bin', 'bash.exe')
    const verdict = verifyGitBash(stagedBash)
    if (!verdict.ok) throw new Error(`extracted PortableGit has no usable Git Bash: ${verdict.reason}`)

    mkdirSync(installDir, { recursive: true })
    if (existsSync(finalDir)) removeOurDirectory(finalDir, installDir)
    renameSync(staging, finalDir)
    writeFileSync(join(installDir, CURRENT_MARKER), `${finalBash}\n`, 'utf8')
    onLog?.(`installed private Git Bash at ${finalBash}`)
    return { ok: true, path: finalBash, installed: true, system: verdict.system }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

/**
 * Download and install PortableGit into a private directory.
 * @param {{ installDir?: string, archiveUrl?: string, expectedSha256?: string, timeoutMs?: number, onLog?: (message: string) => void }} [options]
 * @returns {Promise<{ ok: true, path: string, installed: boolean, system: string }>}
 */
export async function provisionGitBash({
  installDir = defaultInstallRoot(),
  archiveUrl = GIT_PROVISION_URL,
  expectedSha256 = GIT_PROVISION_SHA256,
  timeoutMs = 300000,
  onLog = () => {},
} = {}) {
  if (provisioning === null) {
    provisioning = (async () => {
      const finalDir = join(installDir, `PortableGit-${GIT_PROVISION_VERSION}`)
      const finalBash = join(finalDir, 'bin', 'bash.exe')
      if (existsSync(finalBash)) {
        const existing = verifyGitBash(finalBash)
        if (existing.ok) {
          writeFileSync(join(installDir, CURRENT_MARKER), `${finalBash}\n`, 'utf8')
          return { ok: true, path: finalBash, installed: false, system: existing.system }
        }
      }

      const downloadRoot = mkdtempSync(join(tmpdir(), 'dsh-gitbash-download-'))
      const archive = join(downloadRoot, ARCHIVE_NAME)
      try {
        await downloadArchive(archiveUrl, archive, { expectedSha256, timeoutMs, onLog })
        return await provisionFromArchive(archive, {
          installDir,
          expectedSha256,
          verifyHash: false,
          onLog,
        })
      } finally {
        rmSync(downloadRoot, { recursive: true, force: true })
      }
    })().finally(() => {
      provisioning = null
    })
  }
  return provisioning
}

/**
 * Resolve Git Bash, provisioning a private Git for Windows install when it is
 * missing and automatic installation is allowed.
 *
 * An explicit `bashPath` or `DSH_GIT_BASH_PATH` is a user decision and is never
 * replaced by a download; it fails loudly instead.
 *
 * @param {{ configured?: string, env?: NodeJS.ProcessEnv, autoInstall?: boolean, installDir?: string, archiveUrl?: string, expectedSha256?: string, onLog?: (message: string) => void }} [options]
 * @returns {Promise<{ ok: true, path: string, source: string, system?: string, checked?: string[] } | { ok: false, reason: string, checked?: string[] }>}
 */
export async function ensureGitBash({
  configured = '',
  env = process.env,
  autoInstall = true,
  installDir = '',
  archiveUrl = GIT_PROVISION_URL,
  expectedSha256 = GIT_PROVISION_SHA256,
  onLog = () => {},
} = {}) {
  const resolution = resolveGitBash({ configured, env })
  if (resolution.ok) return resolution

  if (!autoInstall) return resolution
  if (expandBashPath(configured, env).length > 0) return resolution
  if ((envValue(env, 'DSH_GIT_BASH_PATH') ?? '').trim().length > 0) return resolution

  if (installDir.trim().length > 0) {
    try {
      const customMarker = readFileSync(join(resolve(installDir), CURRENT_MARKER), 'utf8').trim()
      if (customMarker.length > 0 && existsSync(customMarker)) {
        const custom = verifyGitBash(customMarker, { env })
        if (custom.ok) return { ok: true, path: customMarker, source: 'provisioned', system: custom.system, checked: [customMarker] }
      }
    } catch {
      // No marker in the custom install directory yet.
    }
  }

  if (lastProvisioned.length > 0 && existsSync(lastProvisioned)) {
    const cached = verifyGitBash(lastProvisioned, { env })
    if (cached.ok) return { ok: true, path: lastProvisioned, source: 'provisioned', system: cached.system, checked: [lastProvisioned] }
  }
  const markerPath = provisionedBashPath(env)
  if (markerPath.length > 0 && existsSync(markerPath)) {
    const cached = verifyGitBash(markerPath, { env })
    if (cached.ok) {
      lastProvisioned = markerPath
      return { ok: true, path: markerPath, source: 'provisioned', system: cached.system, checked: [markerPath] }
    }
  }

  try {
    const installed = await provisionGitBash({
      installDir: installDir.trim().length > 0 ? resolve(installDir) : defaultInstallRoot(env),
      archiveUrl,
      expectedSha256,
      onLog,
    })
    lastProvisioned = installed.path
    return { ok: true, path: installed.path, source: 'provisioned', system: installed.system, checked: [installed.path] }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ...resolution,
      reason: `${resolution.reason}; automatic Git installation failed: ${detail}. Install Git for Windows manually: ${GIT_BASH_INSTALL_URL}`,
    }
  }
}
