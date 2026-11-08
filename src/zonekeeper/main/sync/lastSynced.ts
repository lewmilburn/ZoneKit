import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Entry } from '../../shared/model'

/** What each profile last wrote to each zone. */
export interface LastSynced {
  get(profileId: string, zoneId: string): Promise<Entry[] | null>
  set(profileId: string, zoneId: string, entries: Entry[]): Promise<void>
}

export function fileLastSynced(filePath: string, onWrite: () => void = () => undefined): LastSynced {
  let chain: Promise<unknown> = Promise.resolve()
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }
  // Unreadable means nothing known, so changes show as conflicts
  const load = async (): Promise<Record<string, Entry[]>> => {
    try {
      const json = JSON.parse(await readFile(filePath, 'utf8')) as unknown
      return json && typeof json === 'object' ? (json as Record<string, Entry[]>) : {}
    } catch {
      return {}
    }
  }
  const key = (profileId: string, zoneId: string): string => `${profileId}:${zoneId}`
  return {
    get: (profileId, zoneId) => locked(async () => (await load())[key(profileId, zoneId)] ?? null),
    set: (profileId, zoneId, entries) =>
      locked(async () => {
        const all = await load()
        // Unchanged, so no upload either
        if (JSON.stringify(all[key(profileId, zoneId)]) === JSON.stringify(entries)) return
        all[key(profileId, zoneId)] = entries
        await mkdir(dirname(filePath), { recursive: true })
        const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`
        try {
          await writeFile(tmp, JSON.stringify(all), { encoding: 'utf8', mode: 0o600 })
          await rename(tmp, filePath)
        } catch (e) {
          await unlink(tmp).catch(() => undefined)
          throw e
        }
        onWrite()
      })
  }
}
