import { useEffect, useState } from 'preact/hooks'
import type { DriftView, IpcResult } from '../shared/ipc'
import { PROFILE_ITEMS } from '../shared/ipc'

// One profile at a time, for the rate limit
let queue: Promise<unknown> = Promise.resolve()
const drifted = new Set<string>()
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((l) => l())

// Checks wait while a sync runs, so they don't compete for the rate limit
let paused = 0
let resume: Array<() => void> = []
const unpaused = (): Promise<void> => (paused === 0 ? Promise.resolve() : new Promise((r) => resume.push(r)))

/** Call the returned function to let checks continue. */
export function pauseDrift(): () => void {
  paused++
  let done = false
  return () => {
    if (done) return
    done = true
    paused--
    if (paused === 0) {
      const waiting = resume
      resume = []
      waiting.forEach((r) => r())
    }
  }
}

let running: Promise<unknown> | null = null

/** Resolves once the check in progress finishes, as it holds the profile's lock. */
export const driftIdle = (): Promise<void> => (running ?? Promise.resolve()).then(() => undefined, () => undefined)

/** Also records whether the profile needs a sync. */
export function checkDrift(profileId: string): Promise<IpcResult<DriftView>> {
  const run = queue.then(unpaused).then(async (): Promise<IpcResult<DriftView>> => {
    let finish = (): void => undefined
    running = new Promise<void>((r) => (finish = r))
    try {
      const r = await window.zonekeeper.profileDrift(profileId)
      const was = drifted.has(profileId)
      if (r.ok && !r.value.inSync) drifted.add(profileId)
      else if (r.ok) drifted.delete(profileId)
      if (was !== drifted.has(profileId)) notify()
      return r
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      running = null
      finish()
    }
  })
  queue = run.catch(() => undefined)
  return run
}

/** Checks every profile with zones. */
export async function checkAllDrift(): Promise<void> {
  const lists = await Promise.all(PROFILE_ITEMS.map((item) => window.zonekeeper.profilesList(item).catch(() => null)))
  const ids = lists.flatMap((l) => (l?.ok ? l.value.filter((p) => p.zoneIds.length > 0).map((p) => p.id) : []))
  for (const id of [...drifted]) if (!ids.includes(id)) drifted.delete(id)
  notify()
  await Promise.all(ids.map((id) => checkDrift(id)))
}

/** Profiles whose zones don't match. */
export function useDriftedIds(): ReadonlySet<string> {
  const [, bump] = useState(0)
  useEffect(() => {
    const l = (): void => bump((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  return drifted
}
