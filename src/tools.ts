import { z } from 'zod'
import type { CommandRunner } from './commands.js'
import { checkCommand, checkContent, checkPath, type GuardrailPolicy } from './policy.js'
import type { AgentAction, ToolName } from './types.js'
import type { Workspace } from './workspace.js'

export const toolInputSchemas = {
  list_files: z
    .object({ dir: z.string().min(1).max(200).default('src/') })
    .strict(),
  read_file: z.object({ path: z.string().min(1).max(200) }).strict(),
  write_file: z
    .object({ path: z.string().min(1).max(200), content: z.string() })
    .strict(),
  run_command: z
    .object({
      command: z.string().min(1).max(40),
      args: z.array(z.string().max(120)).max(8).default([]),
    })
    .strict(),
  finish: z.object({ summary: z.string().min(1).max(500) }).strict(),
} satisfies Record<ToolName, z.ZodTypeAny>

export interface ExecutionState {
  writes: number
  writeBytes: number
  originals: Map<string, string | null>
  filesWritten: string[]
}

export function createExecutionState(): ExecutionState {
  return { writes: 0, writeBytes: 0, originals: new Map(), filesWritten: [] }
}

export type ToolOutcome =
  | { kind: 'allowed'; output: string }
  | { kind: 'error'; error: string }
  | { kind: 'blocked'; reason: string }

export interface ToolContext {
  workspace: Workspace
  policy: GuardrailPolicy
  runner: CommandRunner
  cwd?: string
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n… (${value.length - max} characters truncated)`
}

function parseInput(tool: ToolName, input: unknown): { data: unknown } | { error: string } {
  const schema = toolInputSchemas[tool] as z.ZodTypeAny
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    const issues = (parsed.error as z.ZodError).issues.map(
      (issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`,
    )
    return { error: `invalid input — ${issues.join('; ')}` }
  }
  return { data: parsed.data }
}

export async function executeTool(
  action: AgentAction,
  context: ToolContext,
  state: ExecutionState,
): Promise<ToolOutcome> {
  if (action.tool === 'finish') {
    return { kind: 'error', error: 'finish must be handled by the agent loop' }
  }

  if (!(action.tool in toolInputSchemas)) {
    return { kind: 'error', error: `unknown tool: ${String(action.tool)}` }
  }

  const parsed = parseInput(action.tool, action.input)
  if ('error' in parsed) {
    return { kind: 'error', error: parsed.error }
  }

  if (action.tool === 'list_files') {
    const input = parsed.data as { dir: string }
    const dir = input.dir.endsWith('/') ? input.dir : `${input.dir}/`
    const reason = checkPath(context.policy, dir, 'dir')
    if (reason) return { kind: 'blocked', reason }

    try {
      const entries = await context.workspace.list(dir)
      if (entries.length === 0) return { kind: 'allowed', output: `${dir}\n(empty)` }
      const limited = entries.slice(0, 200)
      const suffix = entries.length > limited.length ? `\n… ${entries.length - limited.length} more` : ''
      return { kind: 'allowed', output: `${dir}\n${limited.join('\n')}${suffix}` }
    } catch (error) {
      return { kind: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }

  if (action.tool === 'read_file') {
    const input = parsed.data as { path: string }
    const reason = checkPath(context.policy, input.path)
    if (reason) return { kind: 'blocked', reason }

    try {
      if (!(await context.workspace.exists(input.path))) {
        return { kind: 'error', error: `${input.path} does not exist` }
      }
      const content = await context.workspace.read(input.path)
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > context.policy.maxFileBytes) {
        return { kind: 'error', error: `${input.path} is ${bytes} bytes, over the read limit` }
      }
      return { kind: 'allowed', output: truncate(content, context.policy.maxOutputChars) }
    } catch (error) {
      return { kind: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }

  if (action.tool === 'write_file') {
    const input = parsed.data as { path: string; content: string }
    const reason = checkPath(context.policy, input.path)
    if (reason) return { kind: 'blocked', reason }
    const contentReason = checkContent(context.policy, input.content)
    if (contentReason) return { kind: 'blocked', reason: contentReason }

    const bytes = Buffer.byteLength(input.content, 'utf8')
    if (state.writes >= context.policy.maxWrites) {
      return { kind: 'blocked', reason: `write budget exhausted (max ${context.policy.maxWrites} files)` }
    }
    if (state.writeBytes + bytes > context.policy.maxTotalWriteBytes) {
      return {
        kind: 'blocked',
        reason: `total write budget exhausted (max ${context.policy.maxTotalWriteBytes} bytes)`,
      }
    }

    try {
      if (!state.originals.has(input.path)) {
        const existed = await context.workspace.exists(input.path)
        state.originals.set(input.path, existed ? await context.workspace.read(input.path) : null)
      }
      await context.workspace.write(input.path, input.content)
      state.writes += 1
      state.writeBytes += bytes
      if (!state.filesWritten.includes(input.path)) state.filesWritten.push(input.path)
      return { kind: 'allowed', output: `wrote ${bytes} bytes to ${input.path}` }
    } catch (error) {
      return { kind: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }

  const input = parsed.data as { command: string; args: string[] }
  const reason = checkCommand(context.policy, input.command, input.args)
  if (reason) return { kind: 'blocked', reason }

  try {
    const result = await context.runner.run(
      input.command,
      input.args,
      context.policy.maxCommandMs,
      context.cwd,
    )
    const output = truncate(
      [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n'),
      context.policy.maxOutputChars,
    )

    if (result.timedOut) {
      return { kind: 'error', error: `command timed out after ${context.policy.maxCommandMs}ms\n${output}` }
    }
    if (result.code !== 0) {
      return { kind: 'error', error: `command exited with code ${result.code}\n${output}` }
    }
    return { kind: 'allowed', output: output || '(no output)' }
  } catch (error) {
    return { kind: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

export function summarizeInput(input: unknown, max = 160): string {
  const text = JSON.stringify(input)
  if (text === undefined) return ''
  return truncate(text, max)
}
