import { spawn } from 'node:child_process'

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
}

export interface CommandRunner {
  run(command: string, args: string[], timeoutMs: number, cwd?: string): Promise<CommandResult>
}

export class ScriptedRunner implements CommandRunner {
  private readonly results: Record<string, CommandResult>

  constructor(results: Record<string, CommandResult> = {}) {
    this.results = results
  }

  async run(command: string, args: string[]): Promise<CommandResult> {
    const key = [command, ...args].join(' ')
    return this.results[key] ?? { code: 127, stdout: '', stderr: `no scripted result for "${key}"` }
  }
}

/** shell: false — the policy has already checked the exact command string. */
export class SpawnRunner implements CommandRunner {
  async run(command: string, args: string[], timeoutMs: number, cwd?: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        shell: false,
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })

      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ code: null, stdout, stderr: `${stderr}${error.message}` })
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr, timedOut })
      })
    })
  }
}
