import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { ProfileItem } from '../../shared/ipc'
import { Tabs } from '../components/ui'
import { ProfilesScreen } from './ProfilesScreen'

type Tab = 'speed' | 'caching'
const TABS = [['speed', 'Speed'], ['caching', 'Caching']] as const

export function SpeedScreen(props: { resetSignal: number; onDirtyChange: (dirty: boolean) => void; target?: { item: ProfileItem; profileId: string } | null }): JSX.Element {
  const [tab, setTab] = useState<Tab>(props.target?.item === 'caching' ? 'caching' : 'speed')
  return (
    <div>
      <Tabs<Tab> tabs={TABS} active={tab} onChange={setTab} />
      <ProfilesScreen key={tab} item={tab} resetSignal={props.resetSignal} onDirtyChange={props.onDirtyChange} initialProfileId={props.target?.item === tab ? props.target.profileId : null} />
    </div>
  )
}
