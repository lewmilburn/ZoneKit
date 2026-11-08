import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Last fully synced version per profile. */
export interface SyncState {
  syncedVersion(profileId: string): number | undefined
  mark(profileId: string, version: number): void
}

export function fileSyncState(path: string, onWrite: () => void = () => undefined): SyncState {
  const load = (): Record<string, number> => {
    try {
      const v: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {}
    } catch {
      // Lost file: profiles just show as pending
      return {}
    }
  }
  return {
    syncedVersion: (profileId) => load()[profileId],
    mark(profileId, version) {
      if (load()[profileId] === version) return
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(`${path}.tmp`, JSON.stringify({ ...load(), [profileId]: version }), { mode: 0o600 })
      renameSync(`${path}.tmp`, path)
      onWrite()
    }
  }
}
