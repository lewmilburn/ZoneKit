import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { Tabs } from '../components/ui'
import { ProfilesScreen } from './ProfilesScreen'
import { ZoneRuleTest } from './ZoneRuleTest'

type Tab = 'rules' | 'test'
const TABS = [['rules', 'Rules'], ['test', 'Test']] as const

export function RulesScreen(props: { resetSignal: number; onDirtyChange: (dirty: boolean) => void; initialProfileId?: string | null }): JSX.Element {
  const [tab, setTab] = useState<Tab>('rules')
  return (
    <div>
      <Tabs<Tab> tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'rules' && <ProfilesScreen item="rules" resetSignal={props.resetSignal} onDirtyChange={props.onDirtyChange} initialProfileId={props.initialProfileId ?? null} />}
      {tab === 'test' && <ZoneRuleTest />}
    </div>
  )
}
