import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GITBASH_SECTION_TEXT,
  demotePwshSection,
  demotePwshTool,
  gitBashDescription,
} from '../lib/prompt.js'

function originalPwshTool() {
  return {
    name: 'pwsh',
    description: 'Execute a PowerShell command. Paths use C:\\... and $env:NAME. Examples: Get-Process.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: { type: 'string', description: 'Examples: "ls"; "Get-Process".' },
        command: { type: 'string', description: 'The PowerShell command to execute.' },
        timeoutMs: { type: 'number', description: 'Timeout.' },
      },
      required: ['description', 'command'],
    },
  }
}

test('gitbash description states Git for Windows, not Linux bash', () => {
  const text = gitBashDescription()
  assert.match(text, /Git for Windows Bash/)
  assert.match(text, /not Linux bash/)
  assert.match(text, /run_in_background/)
  assert.match(text, /pwsh/)
  assert.match(text, /\$\{VAR:\?\}/)
})

test('gitbash description can omit background execution', () => {
  const text = gitBashDescription({ background: false })
  assert.match(text, /Background execution is not available/)
})

test('pwsh is routed with all syntax and examples preserved', () => {
  const original = originalPwshTool()
  const demoted = demotePwshTool(original)
  assert.notEqual(demoted, original)
  assert.equal(original.description, 'Execute a PowerShell command. Paths use C:\\... and $env:NAME. Examples: Get-Process.')
  assert.match(demoted.description, /PowerShell is not the default shell/)
  assert.match(demoted.description, /use this PowerShell tool only for Windows-native operations/)
  assert.match(demoted.description, /Get-Process/)
  assert.match(demoted.description, /\$env:NAME/)
  assert.equal(demoted.parameters, original.parameters)
  assert.equal(original.parameters.properties.command.description, 'The PowerShell command to execute.')
  assert.equal(demotePwshTool(demoted), demoted)
})

test('non-pwsh tools and sections pass through unchanged', () => {
  const read = { name: 'read', description: 'Read a file.', parameters: {} }
  assert.equal(demotePwshTool(read), read)
  const section = { name: 'tool:read', text: 'read guidance' }
  assert.equal(demotePwshSection(section), section)
})

test('pwsh section is routed while preserving its original result guidance', () => {
  const originalText = 'Non-zero exits are reported as `[exit code: N]` markers. On Windows a killed process settles as `[exit code: 1]`.'
  const section = { name: 'tool:pwsh', order: 1010, text: originalText }
  const demoted = demotePwshSection(section)
  assert.notEqual(demoted, section)
  assert.equal(section.text, originalText)
  assert.match(demoted.text, /Prefer `gitbash` for shell work/)
  assert.match(demoted.text, /Non-zero exits are reported/)
  assert.match(demoted.text, /On Windows a killed process settles/)
  assert.equal(demotePwshSection(demoted), demoted)
})

test('routing section names Git Bash, pwsh, and the exit marker', () => {
  assert.match(GITBASH_SECTION_TEXT, /gitbash/)
  assert.match(GITBASH_SECTION_TEXT, /Git for Windows Bash/)
  assert.match(GITBASH_SECTION_TEXT, /pwsh/)
  assert.match(GITBASH_SECTION_TEXT, /\[exit code: N\]/)
})
