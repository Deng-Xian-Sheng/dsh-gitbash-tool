import assert from 'node:assert/strict'
import test from 'node:test'
import {
  candidateBashPaths,
  describeGitBashFailure,
  hasLowIntegrityBash,
  resolveGitBash,
  verifyGitBash,
} from '../lib/git-bash.js'

test('resolves a usable Git for Windows Bash on this machine', { skip: process.platform !== 'win32' }, () => {
  const result = resolveGitBash()
  assert.equal(result.ok, true, JSON.stringify(result, null, 2))
  assert.match(result.path, /bash\.exe$/i)
  assert.match(result.system, /^(MINGW|MSYS)/i)
})

test('an explicit configured path wins and is validated', { skip: process.platform !== 'win32' }, () => {
  const first = resolveGitBash()
  assert.equal(first.ok, true)
  const result = resolveGitBash({ configured: first.path })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'config')
  assert.equal(result.path, first.path)
})

test('the resolved Git Bash has a normal integrity label', { skip: process.platform !== 'win32' }, () => {
  const result = resolveGitBash()
  assert.equal(result.ok, true, JSON.stringify(result, null, 2))
  assert.equal(hasLowIntegrityBash(result.path), false)
})

test('a missing configured path fails closed instead of falling back', () => {
  const result = resolveGitBash({ configured: 'C:\\definitely-missing\\bash.exe' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /configured bashPath/)
})

test('rejects a non-Git bash executable', () => {
  const result = verifyGitBash('C:\\Windows\\System32\\bash.exe')
  assert.equal(result.ok, false)
})

test('failure text names the prerequisite and the checked paths', () => {
  const text = describeGitBashFailure({ ok: false, reason: 'not found', checked: ['C:\\a\\bash.exe'] })
  assert.match(text, /Git for Windows/)
  assert.match(text, /DSH_GIT_BASH_PATH/)
  assert.match(text, /C:\\a\\bash\.exe/)
})

test('candidate list includes the per-user Programs install and skips System32 PATH entries', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramW6432: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    SystemRoot: 'C:\\Windows',
    PATH: 'C:\\Windows\\System32;C:\\Tools\\Git\\bin',
  }
  const candidates = candidateBashPaths(env)
  assert.ok(candidates.includes('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'))
  assert.ok(candidates.includes('C:\\Tools\\Git\\bin\\bash.exe'))
  assert.ok(!candidates.some((candidate) => candidate.toLowerCase().startsWith('c:\\windows\\system32')))
})
