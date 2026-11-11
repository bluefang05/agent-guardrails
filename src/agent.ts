import type { CommandRunner } from './commands.js'
import type { GuardrailPolicy } from './policy.js'
import { createExecutionState, executeTool, toolInputSchemas } from './tools.js'
import type { AgentAction, Llm, RunResult, RunStatus, StepRecord } from './types.js'
import type { Workspace } from './workspace.js'

export interface RunAgentOptions {
  task: string
  policy: GuardrailPolicy
  workspace: Workspace
  runner: CommandRunner
  llm: Llm
  cwd?: string
  now?: () => number
}

export async function rollback(
  workspace: Workspace,
  originals: Map<string, string | null>,
): Promise<string[]> {
  const restored: string[] = []

  for (const [path, content] of originals) {
    if (content === null) {
      if (await workspace.exists(path)) await workspace.remove(path)
    } else {
      await workspace.write(path, content)
    }
    restored.push(path)
  }

  return restored
}

export async function runAgent(options: RunAgentOptions): Promise<RunResult> {
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  const state = createExecutionState()
  const steps: StepRecord[] = []
  let toolCalls = 0

  const budgets = {
    maxSteps: options.policy.maxSteps,
    maxToolCalls: options.policy.maxToolCalls,
    maxWrites: options.policy.maxWrites,
    maxWallClockMs: options.policy.maxWallClockMs,
  }

  async function conclude(status: RunStatus, reason?: string, summary?: string): Promise<RunResult> {
    const restoredFiles = status === 'finished' ? [] : await rollback(options.workspace, state.originals)
    return {
      status,
      summary,
      reason,
      steps,
      filesWritten: [...state.filesWritten],
      restoredFiles,
      durationMs: now() - startedAt,
      budgets,
    }
  }

  for (let index = 1; index <= options.policy.maxSteps; index += 1) {
    if (now() - startedAt > options.policy.maxWallClockMs) {
      return conclude('budget_exceeded', `wall-clock budget of ${options.policy.maxWallClockMs}ms exhausted`)
    }
    if (toolCalls >= options.policy.maxToolCalls) {
      return conclude('budget_exceeded', `tool-call budget of ${options.policy.maxToolCalls} exhausted`)
    }

    let action: AgentAction
    try {
      action = await options.llm.next({ task: options.task, steps: [...steps] })
    } catch (error) {
      return conclude('blocked', `model failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (action.tool === 'finish') {
      const parsed = toolInputSchemas.finish.safeParse(action.input)
      const step: StepRecord = {
        index,
        thought: action.thought,
        tool: 'finish',
        input: action.input,
        decision: parsed.success ? 'finished' : 'error',
        detail: parsed.success ? parsed.data.summary : 'invalid summary',
      }
      steps.push(step)
      if (!parsed.success) continue
      return conclude('finished', undefined, parsed.data.summary)
    }

    toolCalls += 1
    const step: StepRecord = {
      index,
      thought: action.thought,
      tool: action.tool,
      input: action.input,
      decision: 'allowed',
    }

    const outcome = await executeTool(
      action,
      {
        workspace: options.workspace,
        policy: options.policy,
        runner: options.runner,
        cwd: options.cwd,
      },
      state,
    )

    if (outcome.kind === 'blocked') {
      step.decision = 'blocked'
      step.detail = outcome.reason
      steps.push(step)
      return conclude('blocked', outcome.reason)
    }

    if (outcome.kind === 'error') {
      step.decision = 'error'
      step.detail = outcome.error
    } else {
      step.output = outcome.output
    }
    steps.push(step)
  }

  return conclude('budget_exceeded', `step budget of ${options.policy.maxSteps} exhausted`)
}
