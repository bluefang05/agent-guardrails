import { extname } from 'node:path'

export interface GuardrailPolicy {
  /** Paths must live under one of these prefixes, e.g. "src/". */
  allowedPathPrefixes: string[]
  allowedExtensions: string[]
  blockedSegments: string[]
  maxFileBytes: number
  maxWriteBytes: number
  maxTotalWriteBytes: number
  /** Exact commands the agent may run. No shell, no wildcards. */
  allowedCommands: string[]
  maxSteps: number
  maxToolCalls: number
  maxWrites: number
  maxCommandMs: number
  maxOutputChars: number
  maxWallClockMs: number
}

export const defaultPolicy: GuardrailPolicy = {
  allowedPathPrefixes: ['src/', 'tests/'],
  allowedExtensions: ['.ts', '.json', '.md'],
  blockedSegments: ['node_modules', '.git'],
  maxFileBytes: 64_000,
  maxWriteBytes: 32_000,
  maxTotalWriteBytes: 96_000,
  allowedCommands: [
    'npm test',
    'npm run build',
    'npm run typecheck',
    'node --version',
    'git status',
    'git diff',
    'git diff --stat',
  ],
  maxSteps: 8,
  maxToolCalls: 12,
  maxWrites: 4,
  maxCommandMs: 20_000,
  maxOutputChars: 4_000,
  maxWallClockMs: 30_000,
}

const shellMetacharacters = /[;&|<>`$]/

const secretPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: 'a PEM private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'an OpenAI-style secret key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
]

export function checkPath(
  policy: GuardrailPolicy,
  rawPath: string,
  kind: 'file' | 'dir' = 'file',
): string | null {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    return 'path must be a non-empty string'
  }
  if (rawPath.includes('\0')) {
    return 'path contains a null byte'
  }

  const path = rawPath.replaceAll('\\', '/')

  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return `absolute paths are not allowed (${rawPath})`
  }

  const segments = path.split('/')
  if (segments.includes('..')) {
    return `path traversal is not allowed (${rawPath})`
  }
  for (const segment of segments) {
    if (policy.blockedSegments.includes(segment)) {
      return `path segment "${segment}" is blocked (${rawPath})`
    }
    if (segment.startsWith('.env')) {
      return `environment files are blocked (${rawPath})`
    }
  }

  if (!policy.allowedPathPrefixes.some((prefix) => path.startsWith(prefix))) {
    return `path must start with ${policy.allowedPathPrefixes.join(' or ')} (${rawPath})`
  }

  if (kind === 'dir') {
    return null
  }

  if (!policy.allowedExtensions.includes(extname(path))) {
    return `extension not allowed: ${extname(path) || '(none)'} (${rawPath})`
  }

  return null
}

export function checkContent(policy: GuardrailPolicy, content: string): string | null {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > policy.maxWriteBytes) {
    return `content is ${bytes} bytes, over the ${policy.maxWriteBytes}-byte write limit`
  }

  for (const { label, pattern } of secretPatterns) {
    if (pattern.test(content)) {
      return `content looks like ${label}`
    }
  }

  return null
}

export function checkCommand(
  policy: GuardrailPolicy,
  command: string,
  args: string[],
): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(command)) {
    return `command name is not allowed: ${command}`
  }
  for (const arg of args) {
    if (shellMetacharacters.test(arg)) {
      return `argument contains shell metacharacters: ${arg}`
    }
    if (arg.includes('..')) {
      return `argument contains path traversal: ${arg}`
    }
  }

  const canonical = [command, ...args].join(' ')
  if (!policy.allowedCommands.includes(canonical)) {
    return `command is not in the allowlist: ${canonical}`
  }
  return null
}
