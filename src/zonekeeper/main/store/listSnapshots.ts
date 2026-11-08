import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const MAX_SNAPSHOTS_PER_LIST = 20

/** Backups of a shared list before it's replaced. */
export interface ListSnapshotStore {
  /** Resolves once safely stored. */
  save(accountId: string, listId: string, items: unknown[]): Promise<string>
}

function safeName(id: string): string {
  return encodeURIComponent(id).replace(/\./g, '%2E')
}

/** References are relative, so no home paths leak. */
export class JsonFileListSnapshotStore implements ListSnapshotStore {
  constructor(private readonly dir: string) {}

  async save(accountId: string, listId: string, items: unknown[]): Promise<string> {
    const folder = join(safeName(accountId), safeName(listId))
    const full = join(this.dir, folder)
    await mkdir(full, { recursive: true, mode: 0o700 })
    const existing = (await readdir(full)).filter((f) => f.endsWith('.json')).sort()
    // Numbered from disk, so order survives restarts
    const next = existing.length === 0 ? 1 : Number.parseInt(existing[existing.length - 1], 10) + 1
    const name = `${String(next).padStart(12, '0')}-${randomBytes(4).toString('hex')}.json`
    const target = join(full, name)
    const tmp = `${target}.tmp`
    const data = JSON.stringify({ accountId, listId, savedAt: new Date().toISOString(), items }, null, 2)
    try {
      const file = await open(tmp, 'wx', 0o600)
      try {
        await file.writeFile(data)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(tmp, target)
    } catch (e) {
      await unlink(tmp).catch(() => {})
      throw e
    }
    await this.syncDir(full)
    await this.prune(full, [...existing, name])
    return join(folder, name)
  }

  /** Best effort: not every platform can sync a directory. */
  private async syncDir(path: string): Promise<void> {
    try {
      const handle = await open(path, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch {
      // Ignored
    }
  }

  /** Failures are ignored: the new snapshot is already safe. */
  private async prune(full: string, names: string[]): Promise<void> {
    for (const old of names.slice(0, Math.max(names.length - MAX_SNAPSHOTS_PER_LIST, 0))) {
      await unlink(join(full, old)).catch(() => {})
    }
  }
}
