import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { PROFILE_ITEMS, type ProfileDto } from '../../shared/ipc'
import { SyncPanel } from './SyncPanel'

/** Each saved or drifted profile in turn. */
export function PendingSync({ onDone, drifted }: { onDone: () => void; drifted: ReadonlySet<string> }): JSX.Element {
  const [queue, setQueue] = useState<ProfileDto[] | null>(null)
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const pending = await window.zonekeeper.syncPending()
      if (!pending.ok) return setError(pending.error)
      const lists = await Promise.all(PROFILE_ITEMS.map((item) => window.zonekeeper.profilesList(item)))
      const off = lists.flatMap((l) => (l.ok ? l.value : [])).filter((p) => drifted.has(p.id) && !pending.value.some((x) => x.id === p.id))
      setQueue([...pending.value, ...off])
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (queue && index >= queue.length) onDone()
  }, [queue, index, onDone])

  if (error) return <p role="alert" className="error">{error}</p>
  const current = queue?.[index]
  if (!current) return <p role="status">Loading...</p>
  return (
    <div>
      <p className="muted">Profile {index + 1} of {queue.length}</p>
      <SyncPanel key={current.id} profileId={current.id} profileName={current.name} onClose={() => setIndex((i) => i + 1)} />
    </div>
  )
}
