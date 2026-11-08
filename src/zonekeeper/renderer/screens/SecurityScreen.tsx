import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { ProfileItem } from '../../shared/ipc'
import { Tabs } from '../components/ui'
import { ProfilesScreen } from './ProfilesScreen'
import { SecurityHeaders } from './SecurityHeaders'
import { WafAnalytics } from './WafAnalytics'

type Tab = 'waf' | 'analytics' | 'headers' | 'https' | 'settings'
const TABS: ReadonlyArray<[Tab, string]> = [['waf', 'WAF'], ['analytics', 'WAF Analytics'], ['headers', 'Security Headers'], ['https', 'HTTPS'], ['settings', 'Security Settings']]

export function SecurityScreen(props: { resetSignal: number; onDirtyChange: (dirty: boolean) => void; target?: { item: ProfileItem; profileId: string } | null }): JSX.Element {
  const [tab, setTab] = useState<Tab>(props.target?.item === 'sechead' ? 'headers' : props.target?.item === 'ssl' ? 'https' : props.target?.item === 'secset' ? 'settings' : 'waf')
  const initial = (item: ProfileItem): string | null => (props.target?.item === item ? props.target.profileId : null)
  return (
    <div>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'waf' && <ProfilesScreen item="security" resetSignal={props.resetSignal} onDirtyChange={props.onDirtyChange} initialProfileId={initial('security')} />}
      {tab === 'settings' && <ProfilesScreen item="secset" resetSignal={props.resetSignal} onDirtyChange={props.onDirtyChange} initialProfileId={initial('secset')} />}
      {tab === 'https' && <ProfilesScreen item="ssl" resetSignal={props.resetSignal} onDirtyChange={props.onDirtyChange} initialProfileId={initial('ssl')} />}
      {tab === 'analytics' && <WafAnalytics />}
      {tab === 'headers' && <SecurityHeaders resetSignal={props.resetSignal} onDirtyChange={props.onDirtyChange} initialProfileId={initial('sechead')} />}
    </div>
  )
}
