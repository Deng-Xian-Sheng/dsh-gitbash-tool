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
    description: 'Execute a PowerShell command and use native Windows paths.',
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

test('pwsh is demoted and its examples are removed without mutating the input', () => {
  const original = originalPwshTool()
  const demoted = demotePwshTool(original)
  assert.notEqual(demoted, original)
  assert.equal(original.description, 'Execute a PowerShell command and use native Windows paths.')
  assert.match(demoted.description, /use the `gitbash` tool/)
  assert.match(demoted.description, /Windows-native/)
  assert.equal(demoted.parameters.properties.command.description, 'The PowerShell command to execute. Use only for Windows-native operations that Git Bash cannot perform.')
  assert.doesNotMatch(demoted.parameters.properties.description.description, /Get-Process/)
  assert.deepEqual(demoted.parameters.required, original.parameters.required)
  assert.equal(original.parameters.properties.command.description, 'The PowerShell command to execute.')
})

test('non-pwsh tools and sections pass through unchanged', () => {
  const read = { name: 'read', description: 'Read a file.', parameters: {} }
  assert.equal(demotePwshTool(read), read)
  const section = { name: 'tool:read', text: 'read guidance' }
  assert.equal(demotePwshSection(section), section)
})

test('pwsh section is rewritten to prefer gitbash', () => {
  const section = { name: 'tool:pwsh', order: 1010, text: 'old' }
  const demoted = demotePwshSection(section)
  assert.notEqual(demoted, section)
  assert.equal(section.text, 'old')
  assert.match(demoted.text, /prefer `gitbash`/)
})

test('routing section names Git Bash, pwsh, and the exit marker', () => {
  assert.match(GITBASH_SECTION_TEXT, /gitbash/)
  assert.match(GITBASH_SECTION_TEXT, /Git for Windows Bash/)
  assert.match(GITBASH_SECTION_TEXT, /pwsh/)
  assert.match(GITBASH_SECTION_TEXT, /\[exit code: N\]/)
})
