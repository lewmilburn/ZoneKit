import { useCallback, useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { MENUS, type AuthState, type Menu, type ProfileItem } from '../shared/ipc'
import logo from '../../../assets/ZoneKeeper.webp'
import { About } from '@app/renderer/About'
import { SearchSelect, WarningBox } from './components/ui'
import { setZoneFilter, useZoneFilter } from './zoneFilter'
import { checkAllDrift, useDriftedIds } from './drift'
import { useTopLevelZones } from './screens/Zones'
import { AnalyticsScreen } from './screens/AnalyticsScreen'
import { PendingSync } from './screens/PendingSync'
import { ProfilesScreen } from './screens/ProfilesScreen'
import { Compliance } from './screens/Compliance'
import { Notifications } from './screens/Notifications'
import { SettingsScreen } from './screens/SettingsScreen'
import { CloudBadge } from './components/CloudBadge'
import { SpeedScreen } from './screens/SpeedScreen'
import { EmailScreen } from './screens/EmailScreen'
import { RulesScreen } from './screens/RulesScreen'
import { SecurityScreen } from './screens/SecurityScreen'
import { Setup } from './screens/Setup'
import { Zones } from './screens/Zones'

type View = 'zones' | 'settings' | 'about' | Menu
const VIEWS: readonly View[] = ['zones', ...MENUS, 'settings', 'about']

const LABELS: Record<View, string> = {
  zones: 'Zones',
  settings: 'Settings',
  about: 'About',
  security: 'Security',
  rules: 'Rules',
  email: 'Email',
  speed: 'Speed',
  network: 'Network',
  compliance: 'Compliance',
  notifications: 'Notifications',
  analytics: 'Analytics'
}

function HeaderZonePicker(): JSX.Element {
  const zones = useTopLevelZones()
  const filter = useZoneFilter()
  return (
    <div className="header-zone">
      <SearchSelect
        label="Show zone"
        options={[['', 'All zones'], ...zones.map((z) => [z.id, z.name] as const)]}
        value={filter ?? ''}
        onChange={(v) => setZoneFilter(v === '' ? null : v)}
        placeholder="All zones"
      />
    </div>
  )
}

export function App(): JSX.Element {
  const [active, setActive] = useState<View>('zones')
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [resetSignal, setResetSignal] = useState(0)
  // Bumped when ZoneKit Cloud replaces the data, so every screen reloads
  const [dataVersion, setDataVersion] = useState(0)
  useEffect(() => window.zonekeeper.onDataChanged(() => setDataVersion((n) => n + 1)), [])
  const [dirty, setDirty] = useState(false)
  const [pendingView, setPendingView] = useState<View | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [syncingAll, setSyncingAll] = useState(false)
  const [emailTarget, setEmailTarget] = useState<{ profileId: string; item: ProfileItem } | null>(null)

  const go = (v: View): void => {
    setEmailTarget(null)
    setSyncingAll(false)
    setActive(v)
    setResetSignal((n) => n + 1)
    setPendingView(null)
    setDirty(false)
  }

  const doneSyncing = useCallback(() => {
    setSyncingAll(false)
    void checkAllDrift()
  }, [])
  const drifted = useDriftedIds()
  const needed = pendingCount + [...drifted].length

  // Zones can change outside the app
  useEffect(() => {
    if (!auth?.signedIn) return
    void checkAllDrift()
    const timer = setInterval(() => void checkAllDrift(), 30 * 60 * 1000)
    return () => clearInterval(timer)
  }, [auth?.signedIn])

  // Polled: saves happen across many screens
  useEffect(() => {
    const check = (): void => {
      void window.zonekeeper.syncPending().then((r) => r.ok && setPendingCount(r.value.length))
    }
    check()
    const timer = setInterval(check, 2000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    window.zonekeeper
      .getAuthState()
      .then(setAuth)
      .catch(() => setAuth({ signedIn: false, notice: null }))
    return window.zonekeeper.onAuthChanged(setAuth)
  }, [])

  if (!auth) return <div className="app" />

  const needsSetup = !auth.signedIn
  return (
    <div className="app">
      <header className="header">
        <img src={logo} alt="Zonekeeper" className="logo" />
        <div className="header-actions">
          {auth.signedIn && (
            <>
              <HeaderZonePicker />
              <button className={needed > 0 ? 'primary' : ''} disabled={needed === 0 || syncingAll} onClick={() => setSyncingAll(true)}>
                {needed > 0 ? 'Sync' : 'Synced'}
              </button>
            </>
          )}
          <button onClick={() => void window.zonekit.openTool('zonetester')}>Open ZoneTester</button>
        </div>
      </header>
      <nav className="sidebar" aria-label="Sections">
        {VIEWS.map((m) => (
          <button
            key={m}
            className={`${m === active ? 'active' : ''}${m === 'settings' ? ' pin-bottom' : ''}`}
            disabled={needsSetup}
            aria-current={m === active ? 'page' : undefined}
            onClick={() => (dirty ? setPendingView(m) : go(m))}
          >
            {LABELS[m]}
          </button>
        ))}
      </nav>
      <main className="content" key={dataVersion}>
        {pendingView && (
          <WarningBox alert>
            <strong>Unsaved changes.</strong> Leave this page and discard your edits?
            <div className="actions">
              <button className="danger" onClick={() => go(pendingView)}>Discard and exit</button>
              <button onClick={() => setPendingView(null)}>Keep editing</button>
            </div>
          </WarningBox>
        )}
        {!needsSetup && syncingAll ? (
          <PendingSync onDone={doneSyncing} drifted={drifted} />
        ) : needsSetup ? (
          <Setup state={auth} onChange={setAuth} />
        ) : active === 'settings' ? (
          <SettingsScreen auth={auth} onAuthChange={setAuth} />
        ) : active === 'zones' ? (
          <Zones
            onOpenProfile={(item, profileId) => {
              setEmailTarget({ profileId, item })
              setActive(item === 'sechead' || item === 'ssl' || item === 'secset' ? 'security' : item === 'caching' ? 'speed' : item)
            }}
          />
        ) : active === 'about' ? (
          <About logo={logo} name="ZoneKeeper" description="Manage your Cloudflare zones with ease. ZoneKeeper keeps rules and settings in sync across every zone you choose, and brings analytics and logs together in one place.">
            <h3>Profiles</h3>
            <p>A profile is a set of settings synced to every zone in it. Zones can use several profiles, and keep their own rules alongside them.</p>
            <h3>Parent zones</h3>
            <p>
              A child zone redirects every request to its parent, so <code>example.net/pricing</code> goes to <code>example.com/pricing</code>, and it follows its parent&apos;s profiles.
            </p>
            <h3>ZoneKit Cloud</h3>
            <p>Stores your profiles in your Cloudflare account, so they follow you to any computer.</p>
            <CloudBadge />
          </About>
        ) : active === 'security' ? (
          <SecurityScreen key={emailTarget?.profileId ?? 'menu'} resetSignal={resetSignal} onDirtyChange={setDirty} target={emailTarget} />
        ) : active === 'speed' ? (
          <SpeedScreen key={emailTarget?.profileId ?? 'menu'} resetSignal={resetSignal} onDirtyChange={setDirty} target={emailTarget} />
        ) : active === 'network' ? (
          <ProfilesScreen key={emailTarget?.profileId ?? 'menu'} item="network" resetSignal={resetSignal} onDirtyChange={setDirty} initialProfileId={emailTarget?.item === 'network' ? emailTarget.profileId : null} />
        ) : active === 'compliance' ? (
          <Compliance key={emailTarget?.profileId ?? 'menu'} resetSignal={resetSignal} onDirtyChange={setDirty} initialProfileId={emailTarget?.item === 'compliance' ? emailTarget.profileId : null} />
        ) : active === 'notifications' ? (
          <Notifications />
        ) : active === 'analytics' ? (
          <AnalyticsScreen resetSignal={resetSignal} />
        ) : active === 'email' ? (
          <EmailScreen key={emailTarget?.profileId ?? 'menu'} resetSignal={resetSignal} onDirtyChange={setDirty} initialProfileId={emailTarget?.item === 'email' ? emailTarget.profileId : null} />
        ) : (
          <RulesScreen key={`${active}:${emailTarget?.profileId ?? ''}`} resetSignal={resetSignal} onDirtyChange={setDirty} initialProfileId={emailTarget?.item === 'rules' ? emailTarget.profileId : null} />
        )}
      </main>
    </div>
  )
}
