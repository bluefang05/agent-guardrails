import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

export interface Workspace {
  list(dir: string): Promise<string[]>
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  remove(path: string): Promise<void>
}

export class MemoryWorkspace implements Workspace {
  private readonly files: Map<string, string>

  constructor(seed: Record<string, string> = {}) {
    this.files = new Map(Object.entries(seed))
  }

  async list(dir: string): Promise<string[]> {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .sort()
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path)
    if (content === undefined) {
      throw new Error(`${path} does not exist in the workspace`)
    }
    return content
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files)
  }
}

/** Real files under a root directory. The root check is defense in depth on top of policy. */
export class DiskWorkspace implements Workspace {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private absolute(path: string): string {
    const target = resolve(this.root, path)
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`refusing to touch a path outside the workspace: ${path}`)
    }
    return target
  }

  async list(dir: string): Promise<string[]> {
    const entries = await readdir(this.absolute(dir), { withFileTypes: true })
    return entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
  }

  async read(path: string): Promise<string> {
    return readFile(this.absolute(path), 'utf8')
  }

  async write(path: string, content: string): Promise<void> {
    const target = this.absolute(path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.absolute(path))
      return true
    } catch {
      return false
    }
  }

  async remove(path: string): Promise<void> {
    await rm(this.absolute(path), { force: true })
  }
}
