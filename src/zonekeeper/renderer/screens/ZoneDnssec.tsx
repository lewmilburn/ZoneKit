import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { errorText } from '../../shared/errorText'
import type { DmarcReportsView, DnssecView, IpcResult, ZoneSummary } from '../../shared/ipc'
import { SettingRow, SettingSingle, WarningBox } from '../components/ui'
import { getZones } from './Zones'
import { ON_OFF } from '../../shared/settingFields'

const STATUS: Record<string, string> = {
  active: 'Active',
  pending: 'Pending: add the DS record at your registrar',
  disabled: 'Off',
  'pending-disabled': 'Turning off',
  error: 'Error'
}

const DNSSEC_OPTIONS = [
  ['nsec3', 'NSEC3', 'Uses hashed denial records, which makes it harder to list every name in the zone.'],
  ['multiSigner', 'Multi-signer DNSSEC', 'For zones also signed by another DNS provider at the same time.'],
  ['presigned', 'Pre-signed DNSSEC', 'For secondary zones that arrive already signed by the primary provider.']
] as const

/** Cached, so each zone is asked once. */
const statusCache = new Map<string, string | null>()
export function useDnssecStatuses(zoneIds: string[]): Record<string, string | null> {
  const [, bump] = useState(0)
  const key = zoneIds.join(',')
  useEffect(() => {
    let live = true
    const missing = zoneIds.filter((id) => !statusCache.has(id))
    void (async () => {
      for (let i = 0; i < missing.length; i += 8) {
        await Promise.all(
          missing.slice(i, i + 8).map(async (id) => {
            const r = await window.zonekeeper.zoneDnssecGet(id).catch(() => null)
            statusCache.set(id, r?.ok ? r.value.status : null)
          })
        )
        if (live) bump((n) => n + 1)
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return Object.fromEntries(zoneIds.map((id) => [id, statusCache.get(id) ?? null]))
}

/** A confirmed on/off toggle. */
function useToggle<T>(load: () => Promise<IpcResult<T>>, deps: unknown[]) {
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    load()
      .then((r) => (r.ok ? setValue(r.value) : setError(r.error)))
      .catch((e: unknown) => setError(errorText(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  async function save(run: () => Promise<IpcResult<T>>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await run()
      if (r.ok) setValue(r.value)
      else setError(r.error)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
      setPending(null)
    }
  }
  return { value, error, pending, setPending, busy, save }
}

type DnssecPatch = { enable?: boolean; multiSigner?: boolean; presigned?: boolean; nsec3?: boolean }

export function ZoneDnssec({ zone }: { zone: ZoneSummary }): JSX.Element {
  const t = useToggle<DnssecView>(() => window.zonekeeper.zoneDnssecGet(zone.id), [zone.id])
  const on = t.value !== null && t.value.status !== 'disabled'
  const [children, setChildren] = useState<ZoneSummary[]>([])
  const [childResults, setChildResults] = useState<Array<{ name: string; text: string; ok: boolean }>>([])
  useEffect(() => {
    if (t.value) statusCache.set(zone.id, t.value.status)
  }, [t.value, zone.id])
  useEffect(() => {
    void Promise.all([window.zonekeeper.parentLinks(), getZones()]).then(([links, zones]) => {
      if (!links.ok || !zones.ok) return
      setChildren(zones.value.filter((z) => links.value[z.id] === zone.id))
    })
  }, [zone.id])

  /** Child zones follow the parent. */
  async function saveAll(patch: DnssecPatch): Promise<void> {
    setChildResults([])
    await t.save(() => window.zonekeeper.zoneDnssecSave({ zoneId: zone.id, ...patch, confirmed: true }))
    const results = await Promise.all(
      children.map(async (c) => {
        try {
          const r = await window.zonekeeper.zoneDnssecSave({ zoneId: c.id, ...patch, confirmed: true })
          if (r.ok) statusCache.set(c.id, r.value.status)
          return r.ok ? { name: c.name, ok: true, text: STATUS[r.value.status] ?? r.value.status } : { name: c.name, ok: false, text: r.error }
        } catch (e) {
          return { name: c.name, ok: false, text: errorText(e) }
        }
      })
    )
    setChildResults(results)
  }

  return (
    <section>
      {t.error && <p role="alert" className="error">{t.error}</p>}
      {children.length > 0 && (
        <p className="muted">
          Changes here also apply to its child zones: {children.map((c) => c.name).join(', ')}. Each one has its own DS record, shown on its own DNSSEC tab.
        </p>
      )}
      {childResults.length > 0 && (
        <ul className="plain-list">
          {childResults.map((r) => (
            <li key={r.name} className={r.ok ? 'muted' : 'error'} role={r.ok ? undefined : 'alert'}>{r.name}: {r.text}</li>
          ))}
        </ul>
      )}
      {!t.value && !t.error && <p role="status">Loading...</p>}
      {t.value && (
        <SettingSingle
          label="DNSSEC"
          help={STATUS[t.value.status] ?? t.value.status}
          options={ON_OFF}
          value={t.pending === null ? (on ? 'on' : 'off') : t.pending ? 'on' : 'off'}
          disabled={t.busy}
          onChange={(v) => t.setPending(v === 'on' === on ? null : v === 'on')}
          footer={
            t.pending !== null && (
              <WarningBox alert>
                {t.pending
                  ? 'Add the DS record below at your registrar to finish.'
                  : 'Remove the DS record at your registrar first, or the domain will stop resolving.'}
                <div className="actions">
                  <button className="primary" disabled={t.busy} onClick={() => void saveAll({ enable: t.pending === true })}>Confirm</button>
                  <button disabled={t.busy} onClick={() => t.setPending(null)}>Cancel</button>
                </div>
              </WarningBox>
            )
          }
        />
      )}
      {t.value && on && (
        <>
          {DNSSEC_OPTIONS.map(([key, label, help]) => (
            <SettingSingle
              key={key}
              label={label}
              help={help}
              options={ON_OFF}
              value={t.value?.[key] ? 'on' : 'off'}
              disabled={t.busy}
              onChange={(v) => void saveAll({ [key]: v === 'on' })}
            />
          ))}
        </>
      )}
      {t.value?.ds && (
        <>
          <h3>DS record for your registrar</h3>
          <pre>{t.value.ds}</pre>
          {([['Key tag', t.value.keyTag], ['Algorithm', t.value.algorithm], ['Digest type', t.value.digestType], ['Digest', t.value.digest]] as const).map(
            ([label, v]) => v && <SettingRow key={label} label={label}><code>{v}</code></SettingRow>
          )}
        </>
      )}
    </section>
  )
}

export function ZoneDmarcReports({ zone }: { zone: ZoneSummary }): JSX.Element {
  const t = useToggle<DmarcReportsView>(() => window.zonekeeper.zoneDmarcReportsGet(zone.id), [zone.id])
  const on = t.value?.enabled === true
  return (
    <section>
      {t.error && <p role="alert" className="error">{t.error}</p>}
      {!t.value && !t.error && <p role="status">Loading...</p>}
      {t.value && (
        <SettingSingle
          label="Cloudflare DMARC reports"
          help={t.value.status ? `Cloudflare reports: ${t.value.status.replace(/-/g, ' ')}.` : 'Collects DMARC reports so you can see who sends mail as this domain.'}
          options={ON_OFF}
          value={t.pending === null ? (on ? 'on' : 'off') : t.pending ? 'on' : 'off'}
          disabled={t.busy}
          onChange={(v) => t.setPending(v === 'on' === on ? null : v === 'on')}
          footer={
            t.pending !== null && (
              <WarningBox alert>
                {t.pending
                  ? "Cloudflare adds its report address to this zone's DMARC record."
                  : 'This stops Cloudflare collecting DMARC reports for this zone.'}
                <div className="actions">
                  <button className="primary" disabled={t.busy} onClick={() => void t.save(() => window.zonekeeper.zoneDmarcReportsSave({ zoneId: zone.id, enable: t.pending === true, confirmed: true }))}>Confirm</button>
                  <button disabled={t.busy} onClick={() => t.setPending(null)}>Cancel</button>
                </div>
              </WarningBox>
            )
          }
        />
      )}
    </section>
  )
}
