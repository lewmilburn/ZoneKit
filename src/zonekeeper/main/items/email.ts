import { diffEntries } from '../../shared/diff'
import type { Change, Entry } from '../../shared/model'
import { isDmarcValue, isSpfValue, type DkimRecord, type EmailSettings } from '../../shared/schemas'
import { CfApiError, type CfClient, type Zone } from '../cloudflare/client'
import { StaleZoneError, UserError, ZoneNotWrittenError } from '../errors'
import type { ItemAdapter, ReadResult } from '../sync/adapter'

export type Area = 'spf' | 'dmarc' | 'dkim' | 'tlsrpt' | 'bimi'

const isTlsRpt = (s: string): boolean => /^v=TLSRPTv1(\s|;|$)/i.test(s.trimStart())
const isBimi = (s: string): boolean => /^v=BIMI1(\s|;|$)/i.test(s.trimStart())
export const tlsRptValue = (email: string): string => `v=TLSRPTv1; rua=mailto:${email}`
export const bimiValue = (b: { logo: string; vmc?: string }): string => `v=BIMI1; l=${b.logo};${b.vmc ? ` a=${b.vmc};` : ''}`
// Cloudflare's DMARC Management adds and owns this report address
const CF_RUA = /@dmarc-reports\.cloudflare\.net$/i
const cfRuas = (record: string): string[] => (tagOf(record, 'rua') ?? '').split(',').map((a) => a.trim()).filter((a) => CF_RUA.test(a))

/** With Cloudflare's report address left out, so it never reads as drift. */
function withoutCfRua(record: string): string {
  const parts = record.split(';').map((p) => p.trim()).filter(Boolean)
  const out = parts.flatMap((p) => {
    if (!p.toLowerCase().startsWith('rua=')) return [p]
    const kept = p.slice(4).split(',').map((a) => a.trim()).filter((a) => a && !CF_RUA.test(a))
    return kept.length > 0 ? [`rua=${kept.join(',')}`] : []
  })
  return out.join('; ')
}

/** Puts Cloudflare's report address back, so a write never drops it. */
function withCfRua(record: string, ruas: string[]): string {
  if (ruas.length === 0) return record
  const own = tagOf(record, 'rua')
  const all = [...(own ? own.split(',').map((a) => a.trim()) : []), ...ruas]
  return [...record.split(';').map((p) => p.trim()).filter((p) => p && !p.toLowerCase().startsWith('rua=')), `rua=${all.join(',')}`].join('; ')
}

const tagOf = (record: string, tag: string): string | undefined =>
  record.split(';').map((p) => p.trim()).find((p) => p.toLowerCase().startsWith(`${tag}=`))?.slice(tag.length + 1).trim()
const PAGE_SIZE = 100
const MAX_PAGES = 100
const MAX_CHUNK_BYTES = 255
const SELECTOR = /^[a-z0-9_-]{1,63}$/

export interface RawRecord {
  id: string
  type: string
  name: string
  content: string
  ttl?: number
  proxied?: boolean
  meta?: { email_routing?: boolean; read_only?: boolean }
}

// Email Routing owns these, writes fail with 1046
const routingOwned = (r: RawRecord): boolean => r.meta?.email_routing === true || r.meta?.read_only === true

export interface Found {
  key: string
  area: Area
  entry: Entry
  raw: RawRecord
}

// TXT content

/** Joins `"a" "b"` into one value, anything else is kept as is. */
export function parseTxt(content: string): string {
  const s = content.trim()
  if (!s.startsWith('"')) return content
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === ' ' || s[i] === '\t') {
      i++
      continue
    }
    if (s[i] !== '"') return content
    i++
    let closed = false
    while (i < s.length) {
      const ch = s[i]
      if (ch === '\\') {
        const dec = /^\d{3}/.exec(s.slice(i + 1, i + 4))
        if (dec) {
          out += String.fromCharCode(Number(dec[0]))
          i += 4
        } else if (i + 1 < s.length) {
          out += s[i + 1]
          i += 2
        } else return content
      } else if (ch === '"') {
        closed = true
        i++
        break
      } else {
        out += ch
        i++
      }
    }
    if (!closed) return content
  }
  return out
}

/** 255-byte quoted strings, the inverse of parseTxt. */
export function formatTxt(value: string): string {
  const chunks: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of value) {
    const esc = ch === '"' || ch === '\\' ? `\\${ch}` : ch
    const size = Buffer.byteLength(esc)
    if (bytes + size > MAX_CHUNK_BYTES) {
      chunks.push(cur)
      cur = ''
      bytes = 0
    }
    cur += esc
    bytes += size
  }
  chunks.push(cur)
  return chunks.map((c) => `"${c}"`).join(' ')
}

import { errorText } from '../../shared/errorText'

function normHost(s: string): string {
  return s.trim().toLowerCase().replace(/\.+$/, '')
}

// Names and keys

const zoneName = (zone: Zone): string => zone.name.toLowerCase()
const baseKey = (key: string): string => key.split('#')[0]
const dkimSuffix = (zone: Zone): string => `._domainkey.${zoneName(zone)}`

function nameFor(zone: Zone, key: string): string {
  const base = baseKey(key)
  if (base === 'spf') return zoneName(zone)
  if (base === 'dmarc') return `_dmarc.${zoneName(zone)}`
  if (base === 'tlsrpt') return `_smtp._tls.${zoneName(zone)}`
  if (base === 'bimi') return `default._bimi.${zoneName(zone)}`
  return `${base.slice('dkim:'.length)}${dkimSuffix(zone)}`
}

function valueOf(e: Entry): { type: 'TXT' | 'CNAME'; content: string; proxied?: boolean; ttl?: number } {
  return e.value as { type: 'TXT' | 'CNAME'; content: string; proxied?: boolean; ttl?: number }
}

function describeFailure(e: unknown): string {
  return errorText(e)
}

// Desired state

function dkimValue(r: DkimRecord, zone: Zone): string {
  if (r.mode === 'shared') return r.value as string
  const per = r.perZone ?? {}
  if (!Object.hasOwn(per, zone.id)) {
    throw new UserError(`The DKIM record "${r.selector}" has no value for ${zone.name}.`)
  }
  return per[zone.id]
}

function dkimEntry(r: DkimRecord, zone: Zone): Entry {
  const raw = dkimValue(r, zone)
  const value =
    r.type === 'TXT'
      ? { type: 'TXT', content: parseTxt(raw), ...(r.ttl === undefined ? {} : { ttl: r.ttl }) }
      : { type: 'CNAME', content: normHost(raw), proxied: false, ...(r.ttl === undefined ? {} : { ttl: r.ttl }) }
  return { key: `dkim:${r.selector.toLowerCase()}`, area: 'dkim', value }
}

export function desiredEntries(settings: EmailSettings, zone: Zone): Entry[] {
  const out: Entry[] = []
  if (settings.spf !== null) {
    out.push({ key: 'spf', area: 'spf', value: { type: 'TXT', content: parseTxt(settings.spf), ...(settings.spfTtl === undefined ? {} : { ttl: settings.spfTtl }) } })
  }
  if (settings.dmarc !== null) {
    const ttl = settings.dmarcTtl === undefined ? {} : { ttl: settings.dmarcTtl }
    out.push({
      key: 'dmarc',
      area: 'dmarc',
      value: settings.dmarcType === 'CNAME' ? { type: 'CNAME', content: normHost(settings.dmarc), proxied: false, ...ttl } : { type: 'TXT', content: parseTxt(settings.dmarc), ...ttl }
    })
  }
  for (const r of settings.dkim) out.push(dkimEntry(r, zone))
  if (settings.tlsRpt !== undefined) out.push({ key: 'tlsrpt', area: 'tlsrpt', value: { type: 'TXT', content: tlsRptValue(settings.tlsRpt) } })
  if (settings.bimi !== undefined) out.push({ key: 'bimi', area: 'bimi', value: { type: 'TXT', content: bimiValue(settings.bimi) } })
  return out
}

// Reading

async function listRecords(client: CfClient, zone: Zone, params: Record<string, string>): Promise<RawRecord[]> {
  const all: RawRecord[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({ ...params, per_page: String(PAGE_SIZE), page: String(page) })
    const { result } = await client.getPage<unknown>(`/zones/${zone.id}/dns_records?${qs}`)
    if (!Array.isArray(result)) throw new UserError('Cloudflare returned an unexpected DNS records list.')
    for (const r of result) {
      const o = r as Record<string, unknown> | null
      if (!o || typeof o.id !== 'string' || typeof o.type !== 'string' || typeof o.name !== 'string' || typeof o.content !== 'string') {
        throw new UserError('Cloudflare returned an unexpected DNS record.')
      }
      all.push(o as unknown as RawRecord)
    }
    if (result.length < PAGE_SIZE) return all
  }
  throw new UserError('Too many pages while reading DNS records.')
}

async function orUnavailable<T>(work: () => Promise<T>): Promise<{ value: T } | 'unavailable'> {
  try {
    return { value: await work() }
  } catch (e) {
    if (e instanceof CfApiError && e.status === 403) return 'unavailable'
    throw e
  }
}

function toEntry(raw: RawRecord, key: string, area: Area, withTtl: boolean): Entry {
  const ttl = withTtl && raw.ttl !== undefined ? { ttl: raw.ttl } : {}
  const text = raw.type === 'TXT' ? parseTxt(raw.content) : ''
  const content = area === 'dmarc' && cfRuas(text).length > 0 ? withoutCfRua(text) : text
  const value =
    raw.type === 'TXT'
      ? { type: 'TXT', content, ...ttl }
      : { type: 'CNAME', content: normHost(raw.content), proxied: raw.proxied === true, ...ttl }
  return { key, area, value }
}

/** The closest record gets the plain key. */
function rank(raw: RawRecord, want: Entry | undefined): number {
  if (!want) return 0
  const w = valueOf(want)
  const have = toEntry(raw, '', 'spf', false).value as { type: string; content: string }
  if (have.type !== w.type) return 2
  return have.content === w.content ? 0 : 1
}

function assign(area: Area, base: string, raws: RawRecord[], desired: Map<string, Entry>): Found[] {
  const want = desired.get(base)
  const ordered = raws
    .map((raw) => ({ raw, r: rank(raw, want) }))
    .sort((a, b) => a.r - b.r || (a.raw.id < b.raw.id ? -1 : a.raw.id > b.raw.id ? 1 : 0))
  return ordered.map(({ raw }, i) => {
    const key = i === 0 ? base : `${base}#${i + 1}`
    return { key, area, entry: toEntry(raw, key, area, i === 0 && want !== undefined && valueOf(want).ttl !== undefined), raw }
  })
}

export interface Scan {
  found: Found[]
  unavailable: Area[]
  warnings: string[]
}

/** A 403 marks an area unavailable. */
export async function scan(client: CfClient, zone: Zone, areas: Area[], desired: Map<string, Entry>): Promise<Scan> {
  const z = zoneName(zone)
  const found: Found[] = []
  const unavailable: Area[] = []
  const warnings: string[] = []

  const single = async (area: 'spf' | 'dmarc' | 'tlsrpt' | 'bimi', name: string, test: (s: string) => boolean, label: string): Promise<void> => {
    // DMARC can also be a CNAME
    const cname = area === 'dmarc'
    const r = await orUnavailable(async () => [
      ...(await listRecords(client, zone, { type: 'TXT', 'name.exact': name })),
      ...(cname ? await listRecords(client, zone, { type: 'CNAME', 'name.exact': name }) : [])
    ])
    if (r === 'unavailable') {
      unavailable.push(area)
      return
    }
    const all = r.value.filter((x) => x.name.toLowerCase() === name && ((x.type === 'TXT' && test(parseTxt(x.content))) || (cname && x.type === 'CNAME')))
    const owned = all.find(routingOwned)
    if (owned) {
      const want = desired.get(area)
      if (want) found.push({ key: area, area, entry: want, raw: owned })
      warnings.push(`${label} is managed by Email Routing on ${zone.name}, so it was left alone.`)
      return
    }
    const matches = all
    if (matches.length > 1) {
      warnings.push(`${zone.name} has more than one ${label} record, only one is allowed.`)
    }
    found.push(...assign(area, area, matches, desired))
  }

  if (areas.includes('spf')) await single('spf', z, isSpfValue, 'SPF')
  if (areas.includes('dmarc')) await single('dmarc', `_dmarc.${z}`, isDmarcValue, 'DMARC')
  if (areas.includes('tlsrpt')) await single('tlsrpt', `_smtp._tls.${z}`, isTlsRpt, 'TLS-RPT')
  if (areas.includes('bimi')) await single('bimi', `default._bimi.${z}`, isBimi, 'BIMI')

  if (areas.includes('dkim')) {
    const suffix = dkimSuffix(zone)
    const r = await orUnavailable(async () => [
      ...(await listRecords(client, zone, { type: 'TXT', 'name.endswith': suffix })),
      ...(await listRecords(client, zone, { type: 'CNAME', 'name.endswith': suffix }))
    ])
    if (r === 'unavailable') unavailable.push('dkim')
    else {
      const bySelector = new Map<string, RawRecord[]>()
      for (const x of r.value) {
        const name = x.name.toLowerCase()
        if (!name.endsWith(suffix) || (x.type !== 'TXT' && x.type !== 'CNAME')) continue
        const selector = name.slice(0, -suffix.length)
        if (!SELECTOR.test(selector)) continue
        if (routingOwned(x)) {
          const key = `dkim:${selector}`
          const want = desired.get(key)
          if (want && !found.some((f) => f.key === key)) {
            found.push({ key, area: 'dkim', entry: want, raw: x })
            warnings.push(`The DKIM selector "${selector}" is managed by Email Routing, so it was left alone.`)
          }
          continue
        }
        bySelector.set(selector, [...(bySelector.get(selector) ?? []), x])
      }
      for (const [selector, raws] of [...bySelector].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const items = assign('dkim', `dkim:${selector}`, raws, desired)
        found.push(...items)
        if (!desired.has(`dkim:${selector}`)) {
          warnings.push(`The DKIM selector "${selector}" isn't in the profile.`)
        } else if (items.length > 1) {
          warnings.push(`More than one record exists for DKIM selector "${selector}". The extra records are shown as conflicts, and removing them can break mail signing.`)
        }
      }
    }
  }
  return { found, unavailable, warnings }
}

function managedAreas(settings: EmailSettings): Area[] {
  // No DKIM records means DKIM isn't managed
  return [
    ...(settings.dkim.length > 0 ? (['dkim'] as const) : []),
    ...(settings.spf !== null ? (['spf'] as const) : []),
    ...(settings.dmarc !== null ? (['dmarc'] as const) : []),
    ...(settings.tlsRpt !== undefined ? (['tlsrpt'] as const) : []),
    ...(settings.bimi !== undefined ? (['bimi'] as const) : [])
  ]
}

// Writing

function changeKey(c: Change): string {
  if (c.type === 'extra') return c.actual.key
  if (c.type === 'different') return c.desired.key
  return c.entry.key
}

function areaOf(c: Change): Area {
  return (c.type === 'extra' ? c.actual.area : c.type === 'different' ? c.desired.area : c.entry.area) as Area
}

function writeBody(zone: Zone, key: string, want: Entry, existing: RawRecord | undefined): Record<string, unknown> {
  const v = valueOf(want)
  const keep = baseKey(key) === 'dmarc' && existing?.type === 'TXT' ? cfRuas(parseTxt(existing.content)) : []
  const content = v.type === 'TXT' ? formatTxt(withCfRua(v.content, keep)) : v.content
  if (!existing) {
    return { type: v.type, name: nameFor(zone, key), content, ttl: v.ttl ?? 1, ...(v.type === 'CNAME' ? { proxied: false } : {}) }
  }
  // Keeps the zone's TTL, comment and tags
  return {
    type: v.type,
    content,
    ...(v.ttl === undefined ? {} : { ttl: v.ttl }),
    ...(v.type === 'CNAME' || existing.type === 'CNAME' ? { proxied: false } : {})
  }
}

export function createEmailAdapter(): ItemAdapter<EmailSettings> {
  const adapter: ItemAdapter<EmailSettings> = {
    item: 'email',

    desired(profile, zone) {
      return desiredEntries(profile.settings, zone)
    },

    async read(client, zone, profile): Promise<ReadResult> {
      // Fails before any read if a DKIM value is missing
      const desired = new Map(desiredEntries(profile.settings, zone).map((e) => [e.key, e]))
      const { found, unavailable, warnings } = await scan(client, zone, managedAreas(profile.settings), desired)
      return { entries: found.map((f) => f.entry), unavailable, warnings }
    },

    // Import reads everything
    async readForImport(client, zone) {
      const { found, unavailable, warnings } = await scan(client, zone, ['spf', 'dmarc', 'dkim', 'tlsrpt', 'bimi'], new Map())
      return { entries: found.filter((f) => !f.key.includes('#')).map((f) => f.entry), unavailable, warnings }
    },

    async apply(client, zone, desired, changes, unavailable) {
      const pending = changes.filter((c) => c.type !== 'unchanged' && !unavailable.includes(areaOf(c)))
      if (pending.length === 0) return
      const areas = [...new Set(pending.map(areaOf))]
      const wanted = new Map(desired.map((e) => [e.key, e]))
      // IDs from this read, not the preview
      const now = await scan(client, zone, areas, wanted)
      if (now.unavailable.length > 0) throw new ZoneNotWrittenError('Cloudflare refused to list some DNS records, so nothing was written.')
      const byKey = new Map(now.found.map((f) => [f.key, f]))
      for (const c of pending) {
        const key = changeKey(c)
        const have = byKey.get(key)
        const actual = c.type === 'extra' || c.type === 'different' ? c.actual : undefined
        const stale = actual === undefined ? have !== undefined : have === undefined || diffEntries([actual], [have.entry])[0].type !== 'unchanged'
        if (stale) throw new StaleZoneError('DNS records changed during this sync, start a new preview.')
      }

      const steps: Array<{ label: string; run: () => Promise<unknown> }> = []
      const path = `/zones/${zone.id}/dns_records`
      for (const c of pending) {
        if (c.type === 'add') {
          steps.push({ label: `create ${c.entry.key}`, run: () => client.send('POST', path, writeBody(zone, c.entry.key, c.entry, undefined)) })
        } else if (c.type === 'different') {
          const id = (byKey.get(c.desired.key) as Found).raw.id
          const existing = (byKey.get(c.desired.key) as Found).raw
          steps.push({ label: `update ${c.desired.key}`, run: () => client.send('PATCH', `${path}/${encodeURIComponent(id)}`, writeBody(zone, c.desired.key, c.desired, existing)) })
        }
      }
      // Deletes last
      for (const c of pending) {
        if (c.type === 'extra') {
          const id = (byKey.get(c.actual.key) as Found).raw.id
          steps.push({ label: `delete ${c.actual.key}`, run: () => client.send('DELETE', `${path}/${encodeURIComponent(id)}`) })
        }
      }

      const completed: string[] = []
      for (const step of steps) {
        try {
          await step.run()
          completed.push(step.label)
        } catch (e) {
          if (completed.length === 0) throw e
          throw new UserError(`${step.label}: ${describeFailure(e)} Already completed for this zone: ${completed.join(', ')}.`)
        }
      }
    },

    addToProfile(profile, zone, change) {
      if (change.type !== 'extra' && change.type !== 'different') return profile
      const { actual } = change
      const v = valueOf(actual)
      if (v.content === '') throw new UserError('This record is empty and can not be added to the profile.')
      const s = profile.settings
      const area = actual.area as Area
      if (area === 'spf') return { ...profile, settings: { ...s, spf: v.content } }
      if (area === 'tlsrpt') {
        const email = (tagOf(v.content, 'rua') ?? '').replace(/^mailto:/i, '').split(',')[0]?.trim() ?? ''
        if (!email) throw new UserError('This TLS-RPT record has no report address to add.')
        return { ...profile, settings: { ...s, tlsRpt: email } }
      }
      if (area === 'bimi') {
        const logo = tagOf(v.content, 'l') ?? ''
        if (!logo) throw new UserError('This BIMI record has no logo to add.')
        const vmc = tagOf(v.content, 'a')
        return { ...profile, settings: { ...s, bimi: { logo, ...(vmc ? { vmc } : {}) } } }
      }
      if (area === 'dmarc') {
        const { dmarcType: _old, ...rest } = s
        return { ...profile, settings: { ...rest, dmarc: v.content, ...(v.type === 'CNAME' ? { dmarcType: 'CNAME' as const } : {}) } }
      }

      const selector = baseKey(actual.key).slice('dkim:'.length)
      const i = s.dkim.findIndex((r) => r.selector.toLowerCase() === selector)
      let record: DkimRecord
      if (i < 0) {
        record = { selector, type: v.type, mode: 'perZone', perZone: { [zone.id]: v.content } }
      } else {
        const old = s.dkim[i]
        if (old.type !== v.type) {
          throw new UserError(`The profile's DKIM record "${selector}" is ${old.type} but this zone's is ${v.type}.`)
        }
        const others =
          old.mode === 'shared'
            ? Object.fromEntries(profile.zoneIds.map((id) => [id, old.value as string]))
            : { ...(old.perZone ?? {}) }
        record = { ...old, mode: 'perZone', perZone: { ...others, [zone.id]: v.content } }
        delete record.value
      }
      const dkim = i < 0 ? [...s.dkim, record] : s.dkim.map((r, n) => (n === i ? record : r))
      return { ...profile, settings: { ...s, dkim } }
    }
  }
  return adapter
}

export const emailAdapter = createEmailAdapter()
