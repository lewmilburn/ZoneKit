import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { CloudStatus } from '../../shared/ipc'
import { LevelBadge } from './ui'

/** Whether ZoneKit Cloud is on, for the About page. */
export function CloudBadge(): JSX.Element | null {
  const [status, setStatus] = useState<CloudStatus | null>(null)
  useEffect(() => {
    void window.zonekeeper.cloudStatus().then((r) => r.ok && setStatus(r.value))
    return window.zonekeeper.onCloudChanged(setStatus)
  }, [])
  if (!status) return null
  if (status.enabled) return <p><LevelBadge level="good">Connected</LevelBadge></p>
  return (
    <>
      <p><LevelBadge level="bad">Not connected</LevelBadge></p>
      <p>Your profiles are not backed up. ZoneKit Cloud is free and protects you against losing your data, we recommend turning it on in settings.</p>
    </>
  )
}
