import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { AuthState } from '../../shared/ipc'
import { Tabs } from '../components/ui'
import { CloudSettings } from './CloudSettings'
import { ProfileTransfer } from './ProfileTransfer'
import { Setup } from './Setup'

type Tab = 'api' | 'profiles' | 'cloud'
const TABS: ReadonlyArray<readonly [Tab, string]> = [['api', 'Cloudflare API'], ['profiles', 'Import and export'], ['cloud', 'ZoneKit Cloud']]

export function SettingsScreen({ auth, onAuthChange }: { auth: AuthState; onAuthChange: (s: AuthState) => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>('api')
  return (
    <div>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'api' && <Setup state={auth} onChange={onAuthChange} />}
      {tab === 'profiles' && <ProfileTransfer />}
      {tab === 'cloud' && <CloudSettings />}
    </div>
  )
}
