import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { CloudAccount, CloudStatus } from '../../shared/ipc'
import { DetailList, LevelBadge, Panel, SettingSingle, WarningBox } from '../components/ui'

const LEVEL_TEXT = { good: 'Saved', info: 'Info', warn: 'Warning', bad: 'Problem' } as const
import { ON_OFF } from '../../shared/settingFields'
import { safe } from './SyncPanel'

/** ZoneKit Cloud: ZoneKeeper's data in the account's Workers KV. */
export function CloudSettings(): JSX.Element {
  const [status, setStatus] = useState<CloudStatus | null>(null)
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null)
  const [account, setAccount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Both copies exist when turning it on
  const [choosing, setChoosing] = useState(false)

  useEffect(() => {
    void safe(window.zonekeeper.cloudStatus()).then((r) => r.ok && setStatus(r.value))
    return window.zonekeeper.onCloudChanged(setStatus)
  }, [])
  useEffect(() => {
    if (status && !status.enabled && accounts === null) {
      void safe(window.zonekeeper.cloudAccounts()).then((r) => {
        if (!r.ok) return setError(r.error)
        setAccounts(r.value)
        if (r.value.length === 1) setAccount((r.value[0] as CloudAccount).id)
      })
    }
  }, [status, accounts])

  async function act(work: () => Promise<{ ok: true; value: CloudStatus } | { ok: false; error: string }>): Promise<void> {
    setBusy(true)
    setError(null)
    const r = await safe(work())
    setBusy(false)
    if (!r.ok) return setError(r.error)
    setStatus(r.value)
    setChoosing(!r.value.enabled && r.value.clash)
  }

  if (!status) return <p role="status">Loading...</p>
  const saved = status.savedAt ? `saved ${new Date(status.savedAt).toLocaleString()}` : null
  // Account and save times are in the details card
  const state = busy ? 'Connecting...' : status.state === 'saving' ? 'Saving...' : null
  const footer = (
    <>
      {error && <WarningBox alert>{error}</WarningBox>}
      {status.enabled && status.state === 'error' && status.error && !status.clash && <WarningBox alert>{status.error}</WarningBox>}
      {status.enabled && status.clash && (
        <WarningBox alert>
          {status.error ?? 'ZoneKit Cloud and this computer both changed.'}
          <div className="actions">
            <button disabled={busy} onClick={() => void act(() => window.zonekeeper.cloudResolve('cloud'))}>Use the cloud copy</button>
            <button className="danger" disabled={busy} onClick={() => void act(() => window.zonekeeper.cloudResolve('local'))}>Use this computer&apos;s</button>
          </div>
        </WarningBox>
      )}
      {!status.enabled && choosing && (
        <WarningBox>
          ZoneKit Cloud already has profiles{saved ? `, ${saved}` : ''}.
          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => void act(() => window.zonekeeper.cloudEnable(account, 'cloud'))}>Use the cloud copy</button>
            <button className="danger" disabled={busy} onClick={() => void act(() => window.zonekeeper.cloudEnable(account, 'local'))}>Replace it with this computer&apos;s</button>
            <button disabled={busy} onClick={() => setChoosing(false)}>Cancel</button>
          </div>
        </WarningBox>
      )}
    </>
  )
  return (
    <section>
      {!status.enabled && accounts && accounts.length > 1 && (
        <SettingSingle<string> label="Account" options={accounts.map((a) => [a.id, a.name] as const)} value={account} onChange={setAccount} />
      )}
      <SettingSingle<'on' | 'off'>
        label="ZoneKit Cloud"
        help={
          <>
            Stores your profiles in your account&apos;s Workers KV. Anyone who has access to your Cloudflare organisation can access them.
            {state && <span className="help-note">{state}</span>}
            {!status.enabled && accounts?.length === 0 && <span className="help-note">This token can&apos;t see any accounts.</span>}
          </>
        }
        options={ON_OFF}
        value={status.enabled ? 'on' : 'off'}
        disabled={busy || choosing || (!status.enabled && !account)}
        onChange={(v) => void act(() => (v === 'on' ? window.zonekeeper.cloudEnable(account) : window.zonekeeper.cloudDisable()))}
        footer={footer}
      />
      {(status.enabled || status.activity.length > 0) && (
        <Panel>
          {status.enabled && (
            <DetailList
              rows={[
                ['Account', status.accountName],
                ['KV namespace', status.namespace],
                ['Key', status.key],
                ['Revision', status.revision > 0 ? String(status.revision) : ''],
                ['Size', status.bytes === null ? '' : status.bytes < 1024 ? `${status.bytes} B` : `${(status.bytes / 1024).toFixed(1)} KB`],
                ['Last saved', status.savedAt ? new Date(status.savedAt).toLocaleString() : ''],
                ['Last checked', status.checkedAt ? new Date(status.checkedAt).toLocaleString() : '']
              ]}
            />
          )}
          {status.activity.length > 0 && (
            <ul className="plain-list">
              {status.activity.map((a) => (
                <li key={`${a.at}:${a.text}`}>
                  <LevelBadge level={a.level}>{LEVEL_TEXT[a.level]}</LevelBadge> <span className="muted">{new Date(a.at).toLocaleString()}</span> {a.text}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </section>
  )
}
