import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAgent } from '../src/agent.js'
import { ScriptedRunner } from '../src/commands.js'
import { ScriptedLlm } from '../src/llm.js'
import { defaultPolicy, type GuardrailPolicy } from '../src/policy.js'
import type { AgentAction, Llm } from '../src/types.js'
import { MemoryWorkspace } from '../src/workspace.js'

async function run(
  actions: AgentAction[],
  options: {
    seed?: Record<string, string>
    policy?: GuardrailPolicy
    commands?: ConstructorParameters<typeof ScriptedRunner>[0]
    llm?: Llm
  } = {},
) {
  const workspace = new MemoryWorkspace(options.seed ?? {})
  const result = await runAgent({
    task: 'test task',
    policy: options.policy ?? defaultPolicy,
    workspace,
    runner: new ScriptedRunner(options.commands),
    llm: options.llm ?? new ScriptedLlm(actions),
  })
  return { result, workspace }
}

const mathSeed = {
  'src/math.ts': 'export function add(a: number, b: number) { return a - b }\n',
}

test('happy path: reads, writes, runs the allowlisted command and finishes', async () => {
  const { result, workspace } = await run(
    [
      { tool: 'list_files', input: { dir: 'src/' } },
      { tool: 'read_file', input: { path: 'src/math.ts' } },
      {
        tool: 'write_file',
        input: { path: 'src/math.ts', content: 'export function add(a: number, b: number) { return a + b }\n' },
      },
      { tool: 'run_command', input: { command: 'npm', args: ['test'] } },
      { tool: 'finish', input: { summary: 'fixed add()' } },
    ],
    {
      seed: mathSeed,
      commands: {
        'npm test': { code: 0, stdout: 'pass 1', stderr: '' },
      },
    },
  )

  assert.equal(result.status, 'finished')
  assert.equal(result.summary, 'fixed add()')
  assert.deepEqual(
    result.steps.map((step) => step.decision),
    ['allowed', 'allowed', 'allowed', 'allowed', 'finished'],
  )
  assert.deepEqual(result.filesWritten, ['src/math.ts'])
  assert.deepEqual(result.restoredFiles, [])
  assert.match(result.steps[3]?.output ?? '', /pass 1/)
  assert.match(await workspace.read('src/math.ts'), /a \+ b/)
})

test('a blocked path aborts the run and restores earlier writes', async () => {
  const { result, workspace } = await run([
    { tool: 'write_file', input: { path: 'src/scratch.ts', content: 'export const scratch = true\n' } },
    { tool: 'write_file', input: { path: 'src/../../escape.ts', content: 'export const escaped = true\n' } },
    { tool: 'finish', input: { summary: 'never reached' } },
  ])

  assert.equal(result.status, 'blocked')
  assert.match(result.reason ?? '', /path traversal/)
  assert.equal(result.steps.length, 2)
  assert.equal(result.steps[1]?.decision, 'blocked')
  assert.equal(await workspace.exists('src/scratch.ts'), false, 'scratch file was rolled back')
  assert.deepEqual(result.restoredFiles, ['src/scratch.ts'])
})

test('a write is rolled back to its previous content', async () => {
  const { result, workspace } = await run(
    [
      { tool: 'write_file', input: { path: 'src/math.ts', content: 'export const hijacked = true\n' } },
      { tool: 'write_file', input: { path: '.env', content: 'SECRET=1' } },
    ],
    { seed: mathSeed },
  )

  assert.equal(result.status, 'blocked')
  assert.equal(await workspace.read('src/math.ts'), mathSeed['src/math.ts'])
})

test('secret-like content is refused and never written', async () => {
  const { result, workspace } = await run([
    {
      tool: 'write_file',
      input: { path: 'src/config.ts', content: 'const key = "-----BEGIN PRIVATE KEY-----\\nabc"' },
    },
  ])

  assert.equal(result.status, 'blocked')
  assert.match(result.reason ?? '', /PEM private key/)
  assert.equal(await workspace.exists('src/config.ts'), false)
})

test('a command outside the allowlist aborts and rolls back', async () => {
  const { result, workspace } = await run([
    { tool: 'write_file', input: { path: 'src/version.ts', content: "export const version = '1.0.1'\n" } },
    { tool: 'run_command', input: { command: 'rm', args: ['-rf', '/'] } },
  ])

  assert.equal(result.status, 'blocked')
  assert.match(result.reason ?? '', /not in the allowlist: rm -rf \//)
  assert.equal(await workspace.exists('src/version.ts'), false)
  assert.deepEqual(result.restoredFiles, ['src/version.ts'])
})

test('the step budget stops a loop and rolls back', async () => {
  const policy = { ...defaultPolicy, maxSteps: 3 }
  const reads: AgentAction[] = Array.from({ length: 8 }, () => ({
    tool: 'read_file',
    input: { path: 'src/math.ts' },
  }))

  const { result, workspace } = await run(
    [{ tool: 'write_file', input: { path: 'src/loop.ts', content: 'export const loop = true\n' } }, ...reads],
    { seed: mathSeed, policy },
  )

  assert.equal(result.status, 'budget_exceeded')
  assert.match(result.reason ?? '', /step budget of 3/)
  assert.equal(result.steps.length, 3)
  assert.equal(await workspace.exists('src/loop.ts'), false)
})

test('the write budget blocks an extra file and restores the rest', async () => {
  const policy = { ...defaultPolicy, maxWrites: 1 }
  const { result, workspace } = await run(
    [
      { tool: 'write_file', input: { path: 'src/one.ts', content: 'export const one = 1\n' } },
      { tool: 'write_file', input: { path: 'src/two.ts', content: 'export const two = 2\n' } },
    ],
    { policy },
  )

  assert.equal(result.status, 'blocked')
  assert.match(result.reason ?? '', /write budget exhausted/)
  assert.equal(await workspace.exists('src/one.ts'), false)
  assert.equal(await workspace.exists('src/two.ts'), false)
})

test('invalid tool input is an error step, not a crash', async () => {
  const { result, workspace } = await run([
    { tool: 'write_file', input: { path: 'src/partial.ts' } },
    { tool: 'write_file', input: { path: 'src/complete.ts', content: 'export const ok = true\n' } },
    { tool: 'finish', input: { summary: 'recovered' } },
  ])

  assert.equal(result.status, 'finished')
  assert.equal(result.steps[0]?.decision, 'error')
  assert.match(result.steps[0]?.detail ?? '', /content/)
  assert.equal(await workspace.exists('src/complete.ts'), true)
})

test('an unknown tool is reported and does not crash the run', async () => {
  const { result } = await run([
    { tool: 'shell' as AgentAction['tool'], input: { command: 'whoami' } },
    { tool: 'finish', input: { summary: 'gave up' } },
  ])

  assert.equal(result.status, 'finished')
  assert.equal(result.steps[0]?.decision, 'error')
  assert.match(result.steps[0]?.detail ?? '', /unknown tool: shell/)
})

test('the wall-clock budget is enforced between steps', async () => {
  let clock = 0
  let calls = 0
  const llm: Llm = {
    async next() {
      calls += 1
      clock = 1_000
      return { tool: 'read_file', input: { path: 'src/math.ts' } }
    },
  }

  const workspace = new MemoryWorkspace(mathSeed)
  const result = await runAgent({
    task: 'slow model',
    policy: { ...defaultPolicy, maxWallClockMs: 500 },
    workspace,
    runner: new ScriptedRunner(),
    llm,
    now: () => clock,
  })

  assert.equal(result.status, 'budget_exceeded')
  assert.match(result.reason ?? '', /wall-clock budget/)
  assert.equal(calls, 1)
  assert.equal(result.steps.length, 1)
})
