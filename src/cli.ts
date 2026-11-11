import { runAgent } from './agent.js'
import { ScriptedRunner } from './commands.js'
import { ScriptedLlm } from './llm.js'
import { defaultPolicy } from './policy.js'
import { scenarios } from './scenarios.js'
import type { RunResult } from './types.js'
import { MemoryWorkspace } from './workspace.js'

function printResult(title: string, result: RunResult): void {
  const status = result.status.toUpperCase()
  console.log(`\n=== ${title} ===`)
  console.log(`status: ${status}${result.reason ? ` — ${result.reason}` : ''}`)
  if (result.summary) console.log(`summary: ${result.summary}`)

  for (const step of result.steps) {
    console.log(`\n[${step.index}] ${step.tool} (${step.decision})`)
    if (step.thought) console.log(`    thought: ${step.thought}`)
    console.log(`    input: ${JSON.stringify(step.input)}`)
    const detail = step.output ?? step.detail
    if (detail) {
      const lines = detail.split('\n')
      const shown = lines.slice(0, 8)
      for (const line of shown) console.log(`    ${line}`)
      if (lines.length > shown.length) console.log(`    … ${lines.length - shown.length} more line(s)`)
    }
  }

  console.log(
    `\nfiles written: ${result.filesWritten.length > 0 ? result.filesWritten.join(', ') : 'none'}`,
  )
  console.log(
    `restored on abort: ${result.restoredFiles.length > 0 ? result.restoredFiles.join(', ') : 'none'}`,
  )
  console.log(
    `budgets: ${result.budgets.maxSteps} steps, ${result.budgets.maxToolCalls} tool calls, ${result.budgets.maxWrites} writes, ${result.budgets.maxWallClockMs}ms`,
  )
  console.log(`duration: ${result.durationMs}ms`)
}

const wanted = process.argv[2]
const selected = wanted ? scenarios.filter((scenario) => scenario.id === wanted) : scenarios

if (selected.length === 0) {
  console.error(`Unknown scenario "${wanted}". Available: ${scenarios.map((scenario) => scenario.id).join(', ')}`)
  process.exit(1)
}

for (const scenario of selected) {
  const workspace = new MemoryWorkspace(scenario.seed)
  const result = await runAgent({
    task: scenario.task,
    policy: scenario.policy ?? defaultPolicy,
    workspace,
    runner: new ScriptedRunner(scenario.commandResults),
    llm: new ScriptedLlm(scenario.actions),
  })
  printResult(scenario.title, result)
}
