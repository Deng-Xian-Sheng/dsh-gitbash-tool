import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  GIT_PROVISION_SHA256,
  GIT_PROVISION_URL,
  defaultInstallRoot,
  provisionFromArchive,
} from '../lib/provision.js'
import { assertGuard } from '../lib/sandbox-guard.js'

test('the automatic Git install is pinned to a versioned HTTPS archive with a SHA-256', () => {
  assert.match(GIT_PROVISION_URL, /^https:\/\/github\.com\/git-for-windows\/git\/releases\/download\/v2\.56\.0\.windows\.4\//)
  assert.match(GIT_PROVISION_URL, /PortableGit-2\.56\.0\.4-64-bit\.7z\.exe$/)
  assert.match(GIT_PROVISION_SHA256, /^[0-9a-f]{64}$/i)
})

test('the default install root is a private per-user directory', () => {
  const root = defaultInstallRoot({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' })
  assert.equal(root, 'C:\\Users\\me\\AppData\\Local\\dsh-gitbash-tool\\git')
})

test('the native sandbox guard artifacts are present', { skip: process.platform !== 'win32' }, () => {
  const result = assertGuard()
  assert.equal(result.ok, true, JSON.stringify(result))
})

test('provisioning a missing archive fails without creating a partial install', async () => {
  await assert.rejects(
    () => provisionFromArchive(join(tmpdir(), 'dsh-gitbash-does-not-exist.7z.exe'), {
      installDir: join(tmpdir(), 'dsh-gitbash-does-not-exist-install'),
      verifyHash: false,
    }),
    /archive is missing/,
  )
})

test('a supplied PortableGit archive extracts into a private install', {
  skip: process.env.DSH_GITBASH_TEST_ARCHIVE === undefined,
}, async () => {
  const installDir = join(tmpdir(), `dsh-gitbash-test-${process.pid}-${Date.now()}`)
  try {
    const result = await provisionFromArchive(process.env.DSH_GITBASH_TEST_ARCHIVE, { installDir })
    assert.equal(result.ok, true)
    assert.match(result.path, /PortableGit-2\.56\.0\.4[\\/]bin[\\/]bash\.exe$/)
    assert.match(result.system, /^(MINGW|MSYS)/i)
  } finally {
    rmSync(installDir, { recursive: true, force: true })
  }
})
