export type ToolName = 'list_files' | 'read_file' | 'write_file' | 'run_command' | 'finish'

export interface AgentAction {
  thought?: string
  tool: ToolName
  input: unknown
}

export type Decision = 'allowed' | 'blocked' | 'error' | 'finished'

export interface StepRecord {
  index: number
  thought?: string
  tool: ToolName
  input: unknown
  decision: Decision
  detail?: string
  output?: string
}

export type RunStatus = 'finished' | 'blocked' | 'budget_exceeded'

export interface RunResult {
  status: RunStatus
  summary?: string
  reason?: string
  steps: StepRecord[]
  filesWritten: string[]
  restoredFiles: string[]
  durationMs: number
  budgets: {
    maxSteps: number
    maxToolCalls: number
    maxWrites: number
    maxWallClockMs: number
  }
}

export interface LlmRequest {
  task: string
  steps: StepRecord[]
}

export interface Llm {
  next(request: LlmRequest): Promise<AgentAction>
}
