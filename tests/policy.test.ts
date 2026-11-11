import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkCommand, checkContent, checkPath, defaultPolicy } from '../src/policy.js'

test('allows files under the permitted prefixes', () => {
  assert.equal(checkPath(defaultPolicy, 'src/math.ts'), null)
  assert.equal(checkPath(defaultPolicy, 'tests/api.test.ts'), null)
  assert.equal(checkPath(defaultPolicy, 'src/nested/deep/file.md'), null)
})

test('rejects absolute paths and traversal', () => {
  assert.match(checkPath(defaultPolicy, '/etc/passwd') ?? '', /absolute paths/)
  assert.match(checkPath(defaultPolicy, 'C:\\Windows\\system.ini') ?? '', /absolute paths/)
  assert.match(checkPath(defaultPolicy, 'src/../secrets.ts') ?? '', /path traversal/)
  assert.match(checkPath(defaultPolicy, 'src/a\\..\\b.ts') ?? '', /path traversal/)
})

test('blocks environment files, node_modules and .git', () => {
  assert.match(checkPath(defaultPolicy, '.env') ?? '', /environment files/)
  assert.match(checkPath(defaultPolicy, 'src/.env.local') ?? '', /environment files/)
  assert.match(checkPath(defaultPolicy, 'node_modules/pkg/index.ts') ?? '', /"node_modules" is blocked/)
  assert.match(checkPath(defaultPolicy, '.git/config.ts') ?? '', /".git" is blocked/)
})

test('rejects paths outside the allowlist and disallowed extensions', () => {
  assert.match(checkPath(defaultPolicy, 'docs/readme.md') ?? '', /must start with/)
  assert.match(checkPath(defaultPolicy, 'src/deploy.sh') ?? '', /extension not allowed/)
  assert.match(checkPath(defaultPolicy, 'src/../../outside.ts') ?? '', /path traversal/)
})

test('directory checks skip the extension rule', () => {
  assert.equal(checkPath(defaultPolicy, 'src/', 'dir'), null)
  assert.match(checkPath(defaultPolicy, 'docs/', 'dir') ?? '', /must start with/)
  assert.equal(checkPath(defaultPolicy, 'src/subdir/', 'dir'), null)
})

test('detects secrets in write content', () => {
  assert.match(
    checkContent(defaultPolicy, '-----BEGIN RSA PRIVATE KEY-----\nabc') ?? '',
    /PEM private key/,
  )
  assert.match(checkContent(defaultPolicy, 'key = AKIAIOSFODNN7EXAMPLE') ?? '', /AWS access key/)
  assert.match(
    checkContent(defaultPolicy, 'token: sk-abcdefghijklmnopqrstuvwxyz123456') ?? '',
    /OpenAI-style secret/,
  )
  assert.equal(checkContent(defaultPolicy, 'export const answer = 42'), null)
})

test('enforces the per-file write limit', () => {
  const tooBig = 'x'.repeat(defaultPolicy.maxWriteBytes + 1)
  assert.match(checkContent(defaultPolicy, tooBig) ?? '', /over the .* write limit/)
})

test('allows only exact commands from the allowlist', () => {
  assert.equal(checkCommand(defaultPolicy, 'npm', ['test']), null)
  assert.equal(checkCommand(defaultPolicy, 'npm', ['run', 'build']), null)
  assert.equal(checkCommand(defaultPolicy, 'git', ['diff', '--stat']), null)
  assert.match(checkCommand(defaultPolicy, 'npm', ['publish']) ?? '', /not in the allowlist/)
  assert.match(checkCommand(defaultPolicy, 'bash', ['-c', 'echo hi']) ?? '', /not in the allowlist/)
})

test('rejects shell metacharacters and traversal in arguments', () => {
  assert.match(checkCommand(defaultPolicy, 'npm', ['test; rm -rf /']) ?? '', /shell metacharacters/)
  assert.match(checkCommand(defaultPolicy, 'npm', ['test && whoami']) ?? '', /shell metacharacters/)
  assert.match(checkCommand(defaultPolicy, 'git', ['diff', '../../etc']) ?? '', /path traversal/)
  assert.match(checkCommand(defaultPolicy, 'npm; rm', ['test']) ?? '', /not allowed/)
})
