import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runAgent } from '../src/agent.js'
import { ScriptedRunner } from '../src/commands.js'
import { ScriptedLlm } from '../src/llm.js'
import { defaultPolicy } from '../src/policy.js'
import { scenarios } from '../src/scenarios.js'
import type { RunResult } from '../src/types.js'
import { MemoryWorkspace } from '../src/workspace.js'

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })

const statusLabel: Record<RunResult['status'], string> = {
  finished: 'Finished',
  blocked: 'Blocked',
  budget_exceeded: 'Budget exhausted',
}

function renderSteps(result: RunResult): string {
  return result.steps
    .map((step) => {
      const detail = step.output ?? step.detail ?? ''
      return `
        <tr>
          <td class="idx">${step.index}</td>
          <td class="tool">
            <code>${escapeHtml(step.tool)}</code>
            ${step.thought ? `<div class="thought">${escapeHtml(step.thought)}</div>` : ''}
            <div class="input">${escapeHtml(JSON.stringify(step.input))}</div>
          </td>
          <td><span class="decision ${escapeHtml(step.decision)}">${escapeHtml(step.decision)}</span></td>
          <td><pre>${escapeHtml(detail)}</pre></td>
        </tr>`
    })
    .join('')
}

function renderScenario(
  title: string,
  description: string,
  task: string,
  result: RunResult,
): string {
  const files =
    result.filesWritten.length > 0 ? result.filesWritten.join(', ') : 'none'
  const restored =
    result.restoredFiles.length > 0 ? result.restoredFiles.join(', ') : 'none'

  return `
    <article class="scenario">
      <header class="scenario-head">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <p class="muted">${escapeHtml(description)}</p>
        </div>
        <span class="status ${escapeHtml(result.status)}">${escapeHtml(statusLabel[result.status])}</span>
      </header>

      <p class="task"><strong>Task:</strong> ${escapeHtml(task)}</p>
      ${result.reason ? `<p class="reason"><strong>Stopped:</strong> ${escapeHtml(result.reason)}</p>` : ''}
      ${result.summary ? `<p class="summary"><strong>Summary:</strong> ${escapeHtml(result.summary)}</p>` : ''}

      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>#</th><th>Tool</th><th>Decision</th><th>Output / reason</th></tr>
          </thead>
          <tbody>${renderSteps(result)}</tbody>
        </table>
      </div>

      <footer class="scenario-foot">
        <span><strong>Written:</strong> ${escapeHtml(files)}</span>
        <span><strong>Rolled back:</strong> ${escapeHtml(restored)}</span>
        <span><strong>Duration:</strong> ${result.durationMs}ms</span>
        <span><strong>Budgets:</strong> ${result.budgets.maxSteps} steps · ${result.budgets.maxToolCalls} calls · ${result.budgets.maxWrites} writes · ${result.budgets.maxWallClockMs}ms</span>
      </footer>
    </article>`
}

const runs = []
for (const scenario of scenarios) {
  const result = await runAgent({
    task: scenario.task,
    policy: scenario.policy ?? defaultPolicy,
    workspace: new MemoryWorkspace(scenario.seed),
    runner: new ScriptedRunner(scenario.commandResults),
    llm: new ScriptedLlm(scenario.actions),
  })
  runs.push(
    renderScenario(scenario.title, scenario.description, scenario.task, result),
  )
}

const commands = defaultPolicy.allowedCommands
  .map((command) => `<code>${escapeHtml(command)}</code>`)
  .join('')

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent guardrails — run transcripts</title>
    <meta name="description" content="Real run transcripts from a coding-agent runner with path, command and budget guardrails." />
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f7f9;
        --card: #ffffff;
        --ink: #16181d;
        --muted: #667085;
        --line: #e3e6ea;
        --green: #166534;
        --green-bg: #dcfce7;
        --amber: #92400e;
        --amber-bg: #fef3c7;
        --red: #991b1b;
        --red-bg: #fee2e2;
        --violet: #5b21b6;
        --violet-bg: #ede9fe;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--ink); line-height: 1.5; }
      header.page {
        max-width: 1180px;
        margin: 0 auto;
        padding: 2.4rem 1.5rem 0.6rem;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.14em;
        font-size: 0.7rem;
        color: var(--muted);
        margin: 0 0 0.4rem;
      }
      h1 { font-size: clamp(1.7rem, 3vw, 2.2rem); margin: 0 0 0.5rem; letter-spacing: -0.02em; }
      .lead { max-width: 62ch; color: var(--muted); margin: 0; }
      .disclosure {
        max-width: 1180px;
        margin: 1.2rem auto 0;
        padding: 0.7rem 1rem;
        background: #eef2ff;
        border: 1px solid #c7d2fe;
        border-radius: 9px;
        font-size: 0.85rem;
        color: #3730a3;
      }
      main { max-width: 1180px; margin: 0 auto; padding: 1.2rem 1.5rem 3rem; }
      .policy {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 1rem 1.1rem;
        margin-bottom: 1.3rem;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 1rem;
      }
      .policy h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 0.35rem; }
      .policy p, .policy div { margin: 0; font-size: 0.86rem; }
      .policy code {
        display: inline-block;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.78rem;
        background: #f3f4f6;
        border: 1px solid var(--line);
        border-radius: 5px;
        padding: 0.05rem 0.32rem;
        margin: 0 0.25rem 0.25rem 0;
      }
      .scenario {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 1.1rem 1.2rem;
        margin-bottom: 1.1rem;
      }
      .scenario-head { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
      .scenario-head h2 { font-size: 1.08rem; margin: 0 0 0.15rem; }
      .muted { color: var(--muted); margin: 0; font-size: 0.88rem; }
      .status {
        font-size: 0.76rem;
        font-weight: 650;
        padding: 0.22rem 0.6rem;
        border-radius: 999px;
        white-space: nowrap;
      }
      .status.finished { background: var(--green-bg); color: var(--green); }
      .status.blocked { background: var(--red-bg); color: var(--red); }
      .status.budget_exceeded { background: var(--violet-bg); color: var(--violet); }
      .task, .reason, .summary { font-size: 0.87rem; margin: 0.55rem 0 0; }
      .reason { color: var(--red); }
      .summary { color: var(--green); }
      .table-wrap { overflow-x: auto; margin-top: 0.8rem; border: 1px solid var(--line); border-radius: 9px; }
      table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
      th, td { text-align: left; padding: 0.5rem 0.65rem; border-bottom: 1px solid var(--line); vertical-align: top; }
      th { background: #fafbfc; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
      tr:last-child td { border-bottom: 0; }
      .idx { color: var(--muted); font-variant-numeric: tabular-nums; }
      .tool code, .input {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .input { color: var(--muted); font-size: 0.76rem; margin-top: 0.2rem; word-break: break-all; }
      .thought { color: var(--muted); font-size: 0.8rem; margin-top: 0.15rem; }
      .decision {
        display: inline-block;
        font-size: 0.72rem;
        font-weight: 650;
        border-radius: 999px;
        padding: 0.1rem 0.5rem;
        background: var(--green-bg);
        color: var(--green);
      }
      .decision.blocked { background: var(--red-bg); color: var(--red); }
      .decision.error { background: var(--amber-bg); color: var(--amber); }
      .decision.finished { background: var(--green-bg); color: var(--green); }
      pre {
        margin: 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.76rem;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 9rem;
        overflow-y: auto;
        color: #1f2937;
      }
      .scenario-foot {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem 1.2rem;
        margin-top: 0.7rem;
        font-size: 0.78rem;
        color: var(--muted);
      }
      footer.page { max-width: 1180px; margin: 0 auto; padding: 0 1.5rem 2.5rem; font-size: 0.78rem; color: var(--muted); }
      footer.page code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    </style>
  </head>
  <body>
    <header class="page">
      <p class="eyebrow">Portfolio project · TypeScript</p>
      <h1>Agent guardrails</h1>
      <p class="lead">
        A small coding-agent runner where every tool is allowlisted, writes are jailed to a
        workspace, budgets are enforced and a failed run rolls back what it wrote.
      </p>
    </header>

    <div class="disclosure">
      These transcripts are generated by <code>npm run build:demo</code> executing the real
      <code>runAgent()</code> against an in-memory workspace, a scripted model and a scripted
      command runner. No LLM calls, no shell and no network here. The repo's tests cover the
      same code paths.
    </div>

    <main>
      <section class="policy">
        <div><h2>Paths</h2><p>Only <code>src/</code> and <code>tests/</code>, extensions <code>.ts</code> <code>.json</code> <code>.md</code>. No <code>..</code>, no absolute paths, no <code>.env</code>.</p></div>
        <div><h2>Commands</h2><p>${commands}</p></div>
        <div><h2>Writes</h2><p>Max 32 KB per file, 96 KB per run, 4 files. Secret patterns (PEM keys, AWS and OpenAI-style keys) are refused.</p></div>
        <div><h2>Budgets</h2><p>8 steps, 12 tool calls, 30 s wall clock. Any violation aborts and restores every file touched.</p></div>
      </section>

      ${runs.join('\n')}
    </main>

    <footer class="page">
      Generated from <code>src/scenarios.ts</code>. The optional OpenAI adapter in
      <code>src/llm.ts</code> is not used by this page.
    </footer>
  </body>
</html>
`

const docsDir = fileURLToPath(new URL('../docs', import.meta.url))
await mkdir(docsDir, { recursive: true })
await writeFile(new URL('../docs/index.html', import.meta.url), html, 'utf8')
console.log(`Wrote ${docsDir}\\index.html (${runs.length} runs)`)
