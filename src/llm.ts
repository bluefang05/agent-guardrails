import type { AgentAction, Llm, LlmRequest } from './types.js'

/** Deterministic model used by tests and the demo: a fixed list of actions. */
export class ScriptedLlm implements Llm {
  private readonly actions: AgentAction[]
  private index = 0

  constructor(actions: AgentAction[]) {
    this.actions = [...actions]
  }

  async next(): Promise<AgentAction> {
    const action = this.actions[this.index]
    this.index += 1
    return action ?? { tool: 'finish', input: { summary: 'Script exhausted.' } }
  }
}

const systemPrompt = `You are a coding agent working inside a restricted workspace.

Reply with exactly one JSON object and nothing else:
{"thought": "short reasoning", "tool": "<tool>", "input": {...}}

Tools:
- list_files: {"dir": "src/"}
- read_file: {"path": "src/file.ts"}
- write_file: {"path": "src/file.ts", "content": "..."}
- run_command: {"command": "npm", "args": ["test"]}
- finish: {"summary": "what changed and how it was verified"}

Only paths under src/ or tests/ are allowed. Only these exact commands are
allowed: npm test, npm run build, npm run typecheck, node --version, git status,
git diff, git diff --stat. Do not include secrets. When the task is done, call
finish. If a tool is blocked, stop and explain.`

export interface OpenAiOptions {
  apiKey: string
  model?: string
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Optional adapter for any OpenAI-compatible chat-completions endpoint. */
export class OpenAiLlm implements Llm {
  private readonly options: Required<Omit<OpenAiOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch }

  constructor(options: OpenAiOptions) {
    this.options = {
      apiKey: options.apiKey,
      model: options.model ?? 'gpt-4o-mini',
      baseUrl: options.baseUrl ?? 'https://api.openai.com/v1',
      timeoutMs: options.timeoutMs ?? 30_000,
      fetchImpl: options.fetchImpl ?? fetch,
    }
  }

  async next(request: LlmRequest): Promise<AgentAction> {
    const history = request.steps
      .map((step) => {
        const detail = (step.output ?? step.detail ?? '').slice(0, 400)
        return `${step.index}. ${step.tool} [${step.decision}] ${JSON.stringify(step.input)}${detail ? ` → ${detail}` : ''}`
      })
      .join('\n')

    const response = await this.options.fetchImpl(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      signal: AbortSignal.timeout(this.options.timeoutMs),
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Task: ${request.task}\n\nSteps so far:\n${history || '(none)'}`,
          },
        ],
      }),
    })

    if (!response.ok) {
      throw new Error(`model request failed with ${response.status}: ${await response.text()}`)
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = payload.choices?.[0]?.message?.content
    if (!content) throw new Error('model returned no content')

    const parsed = JSON.parse(content) as Partial<AgentAction>
    if (typeof parsed.tool !== 'string') throw new Error('model response has no tool')
    return { thought: parsed.thought, tool: parsed.tool as AgentAction['tool'], input: parsed.input }
  }
}
