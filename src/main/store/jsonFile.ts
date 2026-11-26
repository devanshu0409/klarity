import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logger } from '../util/log'

const log = logger('store')

/**
 * A versioned JSON file in userData, written atomically (temp + rename) so a
 * crash mid-write cannot leave a truncated file that loses every profile.
 * A corrupt file is moved aside rather than deleted — the user keeps a chance
 * to recover it by hand.
 */
export class JsonFile<T extends { version: number }> {
  private readonly path: string
  private data: T

  constructor(
    filename: string,
    private readonly defaults: T
  ) {
    this.path = join(app.getPath('userData'), filename)
    this.data = this.load()
  }

  private load(): T {
    if (!existsSync(this.path)) return structuredClone(this.defaults)
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as T
      return { ...structuredClone(this.defaults), ...parsed }
    } catch (err) {
      const backup = `${this.path}.corrupt-${Date.now()}`
      try {
        renameSync(this.path, backup)
        log.error(`Unreadable ${this.path}; moved to ${backup}`, err)
      } catch {
        log.error(`Unreadable ${this.path} and could not move it aside`, err)
      }
      return structuredClone(this.defaults)
    }
  }

  get(): T {
    return this.data
  }

  update(mutate: (draft: T) => void): T {
    mutate(this.data)
    this.persist()
    return this.data
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, this.path)
  }
}
