import { describe, expect, it } from 'vitest'
import { createElement } from 'preact'
import { renderToStaticMarkup } from 'preact-render-to-string'
import { diffEntries } from '../../../src/zonekeeper/shared/diff'
import type { Change, Profile } from '../../../src/zonekeeper/shared/model'
import { parseProfile, type EmailSettings } from '../../../src/zonekeeper/shared/schemas'
import { CfClient, type Zone } from '../../../src/zonekeeper/main/cloudflare/client'
import { StaleZoneError, UserError } from '../../../src/zonekeeper/main/errors'
import { createEmailAdapter, emailAdapter, formatTxt, parseTxt } from '../../../src/zonekeeper/main/items/email'
import { EmailProfile } from '../../../src/zonekeeper/renderer/screens/EmailProfile'

const ZONE: Zone = { id: 'z1', name: 'a.com' }
const adapter = createEmailAdapter()

interface Rec {
  id: string
  type: string
  name: string
  content: string
  ttl?: number
  proxied?: boolean
  comment?: string
}
interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: any
}

/** A small in-memory DNS zone behind the real client. It honours the list filters like Cloudflare does. */
function dns(
  initial: Rec[],
  opts: { forbid?: (q: URLSearchParams) => boolean; fail?: (c: Call) => boolean; onList?: () => void } = {}
) {
  let records = initial.map((r) => ({ ...r }))
  let n = 0
  const calls: Call[] = []
  const client = new CfClient({
    getToken: async () => 'tok',
    maxRetries: 0,
    fetch: (async (input: string, init: RequestInit) => {
      const url = new URL(input)
      const path = url.pathname.replace('/client/v4', '')
      const call: Call = { method: init.method ?? 'GET', path, query: url.searchParams, body: init.body ? JSON.parse(init.body as string) : undefined }
      calls.push(call)
      const reply = (status: number, result: unknown, extra: object = {}) =>
        new Response(JSON.stringify({ success: status < 400, result: status < 400 ? result : null, errors: status < 400 ? [] : [{ code: status, message: `HTTP ${status}` }], ...extra }), { status })
      if (opts.fail?.(call)) return reply(500, null)
      const base = '/zones/z1/dns_records'
      if (call.method === 'GET' && path === base) {
        opts.onList?.()
        if (opts.forbid?.(call.query)) return reply(403, null)
        const q = call.query
        let out = records.filter((r) => !q.get('type') || r.type === q.get('type'))
        const exact = q.get('name.exact')
        const ends = q.get('name.endswith')
        if (exact) out = out.filter((r) => r.name === exact)
        if (ends) out = out.filter((r) => r.name.endsWith(ends))
        const per = Number(q.get('per_page') ?? 100)
        const page = Number(q.get('page') ?? 1)
        return reply(200, out.slice((page - 1) * per, page * per), { result_info: { page, per_page: per, total_count: out.length } })
      }
      if (call.method === 'POST' && path === base) {
        const rec = { id: `new${++n}`, ...call.body }
        records.push(rec)
        return reply(200, rec)
      }
      const m = path.match(/^\/zones\/z1\/dns_records\/(.+)$/)
      if (m && call.method === 'PATCH') {
        const rec = records.find((r) => r.id === m[1])
        if (!rec) return reply(404, null)
        Object.assign(rec, call.body)
        return reply(200, rec)
      }
      if (m && call.method === 'DELETE') {
        records = records.filter((r) => r.id !== m[1])
        return reply(200, { id: m[1] })
      }
      return reply(500, null)
    }) as unknown as typeof fetch
  })
  return {
    client,
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET'),
    records: () => records,
    mutate: (fn: (r: Rec[]) => Rec[]) => {
      records = fn(records)
    }
  }
}

const txt = (id: string, name: string, content: string, extra: Partial<Rec> = {}): Rec => ({ id, type: 'TXT', name, content, ttl: 300, ...extra })
const cname = (id: string, name: string, content: string, extra: Partial<Rec> = {}): Rec => ({ id, type: 'CNAME', name, content, ttl: 300, proxied: false, ...extra })

function settings(over: Partial<EmailSettings> = {}): EmailSettings {
  return { spf: null, dmarc: null, dkim: [], ...over }
}
function profile(s: EmailSettings): Profile<EmailSettings> {
  return { id: 'p', item: 'email', name: 'P', version: 1, zoneIds: ['z1'], settings: s, updatedAt: 't' }
}

async function preview(client: CfClient, p: Profile<EmailSettings>, zone: Zone = ZONE) {
  const read = await adapter.read(client, zone, p)
  const desired = adapter.desired(p, zone).filter((e) => !read.unavailable.includes(e.area))
  const entries = read.entries.filter((e) => !read.unavailable.includes(e.area))
  return { read, desired, changes: diffEntries(desired, entries) }
}
async function sync(client: CfClient, p: Profile<EmailSettings>, zone: Zone = ZONE) {
  const { read, desired, changes } = await preview(client, p, zone)
  await adapter.apply(client, zone, desired, changes, read.unavailable)
  return changes
}

const SPF = 'v=spf1 include:_spf.example.com -all'
const DMARC = 'v=DMARC1; p=reject'

describe('read', () => {
  it('exports the adapter for the email item', () => {
    expect(emailAdapter.item).toBe('email')
  })

  it('ignores other apex TXT, v=spf1 on subdomains, non-DMARC at _dmarc, and deeper DKIM names', async () => {
    const { client } = dns([
      txt('1', 'a.com', '"google-site-verification=xyz"'),
      txt('2', 'mail.a.com', '"v=spf1 -all"'),
      txt('3', '_dmarc.a.com', '"something else"'),
      txt('4', 'x.y._domainkey.a.com', '"v=DKIM1; p=deep"'),
      txt('5', 'sub.a.com', '"v=DKIM1; p=sub"'),
      txt('6', 's1._domainkey.mail.a.com', '"v=DKIM1; p=sub"'),
      txt('7', '_domainkey.a.com', '"o=~"')
    ])
    const r = await adapter.read(client, ZONE, profile(settings({ spf: SPF, dmarc: DMARC })))
    expect(r.entries).toEqual([])
    expect(r.warnings ?? []).toEqual([])
  })

  it('treats chunked quoted TXT as equal to the joined value', async () => {
    const { client } = dns([txt('1', 'a.com', '"v=spf1 " "-all"')])
    const p = profile(settings({ spf: 'v=spf1 -all' }))
    const { changes } = await preview(client, p)
    expect(changes.map((c) => c.type)).toEqual(['unchanged'])
  })

  it('compares long values split into 255 byte chunks with the joined form', async () => {
    const long = 'v=DKIM1; k=rsa; p=' + 'A'.repeat(400)
    const { client } = dns([txt('1', 's1._domainkey.a.com', formatTxt(long))])
    const p = profile(settings({ dkim: [{ selector: 's1', type: 'TXT', mode: 'shared', value: long }] }))
    const { changes } = await preview(client, p)
    expect(changes.map((c) => c.type)).toEqual(['unchanged'])
  })

  it('normalises CNAME case and trailing dot', async () => {
    const { client } = dns([cname('1', 's1._domainkey.a.com', 'Sel.Provider.NET.')])
    const p = profile(settings({ dkim: [{ selector: 's1', type: 'CNAME', mode: 'shared', value: 'sel.provider.net' }] }))
    expect((await preview(client, p)).changes.map((c) => c.type)).toEqual(['unchanged'])
  })

  it('does not change proxied semantics: a proxied DKIM CNAME is different', async () => {
    const { client } = dns([cname('1', 's1._domainkey.a.com', 'sel.provider.net', { proxied: true })])
    const p = profile(settings({ dkim: [{ selector: 's1', type: 'CNAME', mode: 'shared', value: 'sel.provider.net' }] }))
    const { changes } = await preview(client, p)
    expect(changes.map((c) => c.type)).toEqual(['different'])
  })

  it('ignores a TTL difference unless the profile sets one', async () => {
    const { client } = dns([txt('1', 'a.com', `"${SPF}"`, { ttl: 3600 })])
    expect((await preview(client, profile(settings({ spf: SPF })))).changes.map((c) => c.type)).toEqual(['unchanged'])
    expect((await preview(client, profile(settings({ spf: SPF, spfTtl: 300 })))).changes.map((c) => c.type)).toEqual(['different'])
    expect((await preview(client, profile(settings({ spf: SPF, spfTtl: 3600 })))).changes.map((c) => c.type)).toEqual(['unchanged'])
  })

  it('does not manage or list SPF and DMARC when they are null', async () => {
    const { client, calls } = dns([txt('1', 'a.com', '"v=spf1 -all"'), txt('2', '_dmarc.a.com', `"${DMARC}"`)])
    const p = profile(settings())
    const { read, changes } = await preview(client, p)
    expect(read.entries).toEqual([])
    expect(changes).toEqual([])
    expect(adapter.desired(p, ZONE)).toEqual([])
    expect(calls.some((c) => c.query.get('name.exact'))).toBe(false)
  })

  it('reports duplicate SPF records with a warning and a suffixed key, never duplicating keys', async () => {
    const { client } = dns([txt('1', 'a.com', '"v=spf1 include:old.example -all"'), txt('2', 'a.com', `"${SPF}"`)])
    const p = profile(settings({ spf: SPF }))
    const { read, changes } = await preview(client, p)
    expect(read.warnings?.some((w) => /more than one SPF/i.test(w))).toBe(true)
    expect(read.entries.map((e) => e.key).sort()).toEqual(['spf', 'spf#2'])
    expect(changes.map((c) => c.type)).toEqual(['unchanged', 'extra'])
    expect((changes[1] as Extract<Change, { type: 'extra' }>).actual.key).toBe('spf#2')
  })

  it('reports duplicate DMARC records the same way', async () => {
    const { client } = dns([txt('1', '_dmarc.a.com', '"v=DMARC1; p=none"'), txt('2', '_dmarc.a.com', '"v=DMARC1; p=quarantine"')])
    const { read, changes } = await preview(client, profile(settings({ dmarc: DMARC })))
    expect(read.warnings?.some((w) => /more than one DMARC/i.test(w))).toBe(true)
    expect(changes.map((c) => c.type).sort()).toEqual(['different', 'extra'])
  })

  it('throws on other errors rather than reading empty', async () => {
    const { client } = dns([], { fail: (c) => c.method === 'GET' })
    await expect(adapter.read(client, ZONE, profile(settings({ spf: SPF })))).rejects.toThrow()
  })

  it('blocks the zone with a clear error when a per-zone DKIM value is missing', async () => {
    const { client } = dns([])
    const p = profile(settings({ dkim: [{ selector: 's1', type: 'TXT', mode: 'perZone', perZone: { other: 'v=DKIM1; p=x' } }] }))
    expect(() => adapter.desired(p, ZONE)).toThrow(UserError)
    expect(() => adapter.desired(p, ZONE)).toThrow(/s1.*a\.com/)
    await expect(adapter.read(client, ZONE, p)).rejects.toThrow(/s1/)
  })

  it('resolves per-zone and shared DKIM values for the zone', () => {
    const p = profile(
      settings({
        dkim: [
          { selector: 'S1', type: 'TXT', mode: 'perZone', perZone: { z1: '"v=DKIM1; " "p=mine"' } },
          { selector: 's2', type: 'CNAME', mode: 'shared', value: 'Target.Example.' }
        ]
      })
    )
    expect(adapter.desired(p, ZONE).map((e) => [e.key, e.value])).toEqual([
      ['dkim:s1', { type: 'TXT', content: 'v=DKIM1; p=mine' }],
      ['dkim:s2', { type: 'CNAME', content: 'target.example', proxied: false }]
    ])
  })

})

describe('apply', () => {
  it('creates missing records with quoted TXT, automatic TTL, and DNS-only CNAME', async () => {
    const d = dns([])
    const p = profile(
      settings({
        spf: SPF,
        dmarc: DMARC,
        dkim: [
          { selector: 's1', type: 'TXT', mode: 'shared', value: 'v=DKIM1; p=abc' },
          { selector: 's2', type: 'CNAME', mode: 'shared', value: 'sel2.provider.net' }
        ]
      })
    )
    await sync(d.client, p)
    const bodies = Object.fromEntries(d.writes().map((c) => [c.body.name, c.body]))
    expect(d.writes().every((c) => c.method === 'POST' && c.path === '/zones/z1/dns_records')).toBe(true)
    expect(bodies['a.com']).toEqual({ type: 'TXT', name: 'a.com', content: `"${SPF}"`, ttl: 1 })
    expect(bodies['_dmarc.a.com']).toEqual({ type: 'TXT', name: '_dmarc.a.com', content: `"${DMARC}"`, ttl: 1 })
    expect(bodies['s1._domainkey.a.com'].content).toBe('"v=DKIM1; p=abc"')
    expect(bodies['s2._domainkey.a.com']).toEqual({ type: 'CNAME', name: 's2._domainkey.a.com', content: 'sel2.provider.net', ttl: 1, proxied: false })
    // converged
    expect((await preview(d.client, p)).changes.every((c) => c.type === 'unchanged')).toBe(true)
  })

  it('writes long TXT values as quoted chunks of at most 255 bytes', async () => {
    const long = 'v=DKIM1; k=rsa; p=' + 'B'.repeat(600)
    const d = dns([])
    await sync(d.client, profile(settings({ dkim: [{ selector: 's1', type: 'TXT', mode: 'shared', value: long }] })))
    const content = d.writes()[0].body.content as string
    const chunks = [...content.matchAll(/"([^"]*)"/g)].map((m) => m[1])
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((c) => Buffer.byteLength(c) <= 255)).toBe(true)
    expect(chunks.join('')).toBe(long)
  })

  it('updates by record ID, keeps the existing TTL, and never touches other records', async () => {
    const d = dns([
      txt('r-spf', 'a.com', '"v=spf1 -all"', { ttl: 3600, comment: 'keep' }),
      txt('r-other', 'a.com', '"google-site-verification=xyz"'),
      txt('r-sub', 'mail.a.com', '"v=spf1 -all"')
    ])
    await sync(d.client, profile(settings({ spf: SPF })))
    expect(d.writes()).toHaveLength(1)
    expect(d.writes()[0]).toMatchObject({ method: 'PATCH', path: '/zones/z1/dns_records/r-spf' })
    expect(d.writes()[0].body).toEqual({ type: 'TXT', content: `"${SPF}"` })
    const rec = d.records().find((r) => r.id === 'r-spf')!
    expect(rec.ttl).toBe(3600)
    expect(rec.comment).toBe('keep')
    expect(d.records().find((r) => r.id === 'r-other')!.content).toBe('"google-site-verification=xyz"')
  })

  it('sends the TTL when the profile sets one', async () => {
    const d = dns([txt('r-spf', 'a.com', '"v=spf1 -all"', { ttl: 3600 })])
    await sync(d.client, profile(settings({ spf: SPF, spfTtl: 120 })))
    expect(d.writes()[0].body.ttl).toBe(120)
  })

  it('changes a record type by updating the same record, with proxied off for CNAME', async () => {
    const d = dns([txt('r1', 's1._domainkey.a.com', '"v=DKIM1; p=x"')])
    await sync(d.client, profile(settings({ dkim: [{ selector: 's1', type: 'CNAME', mode: 'shared', value: 'sel.provider.net' }] })))
    expect(d.writes()).toHaveLength(1)
    expect(d.writes()[0]).toMatchObject({ method: 'PATCH', path: '/zones/z1/dns_records/r1', body: { type: 'CNAME', content: 'sel.provider.net', proxied: false } })
  })

  it('turns a proxied DKIM CNAME to DNS only', async () => {
    const d = dns([cname('r1', 's1._domainkey.a.com', 'sel.provider.net', { proxied: true })])
    await sync(d.client, profile(settings({ dkim: [{ selector: 's1', type: 'CNAME', mode: 'shared', value: 'sel.provider.net' }] })))
    expect(d.writes()[0].body.proxied).toBe(false)
  })

  it('deletes confirmed extras only after every create and update', async () => {
    const d = dns([txt('old', 'old._domainkey.a.com', '"v=DKIM1; p=old"'), txt('spf1', 'a.com', '"v=spf1 -all"'), txt('spf2', 'a.com', '"v=spf1 +all"')])
    await sync(d.client, profile(settings({ spf: SPF, dkim: [{ selector: 'new', type: 'TXT', mode: 'shared', value: 'v=DKIM1; p=n' }] })))
    const methods = d.writes().map((c) => c.method)
    expect(methods.lastIndexOf('POST')).toBeLessThan(methods.indexOf('DELETE'))
    expect(methods.lastIndexOf('PATCH')).toBeLessThan(methods.indexOf('DELETE'))
    expect(methods.filter((m) => m === 'DELETE')).toHaveLength(2)
    // exactly one SPF record is left
    expect(d.records().filter((r) => r.name === 'a.com')).toHaveLength(1)
    expect(d.records().filter((r) => r.name === 'a.com')[0].content).toBe(`"${SPF}"`)
    expect(d.records().some((r) => r.id === 'old')).toBe(false)
  })

  it('reports completed steps when a later step fails, and deletes nothing', async () => {
    const d = dns([txt('old', 'old._domainkey.a.com', '"v=DKIM1; p=old"')], {
      fail: (c) => c.method === 'POST' && c.body?.name === '_dmarc.a.com'
    })
    const p = profile(settings({ spf: SPF, dmarc: DMARC }))
    const err = await sync(d.client, p).catch((e) => e)
    expect(err).toBeInstanceOf(UserError)
    expect(err.message).toMatch(/dmarc/)
    expect(err.message).toMatch(/Already completed for this zone: create spf/)
    expect(d.writes().some((c) => c.method === 'DELETE')).toBe(false)
    expect(d.records().some((r) => r.id === 'old')).toBe(true)
  })

  it('rethrows the original error when the first step fails', async () => {
    const d = dns([], { fail: (c) => c.method === 'POST' })
    await expect(sync(d.client, profile(settings({ spf: SPF })))).rejects.not.toThrow(/Already completed/)
  })

  it('refuses with a stale error and writes nothing when a record changed after the preview', async () => {
    const d = dns([txt('r1', 'a.com', '"v=spf1 -all"')])
    const p = profile(settings({ spf: SPF, dmarc: DMARC }))
    const { read, desired, changes } = await preview(d.client, p)
    d.mutate((rs) => rs.map((r) => (r.id === 'r1' ? { ...r, content: '"v=spf1 +all"' } : r)))
    await expect(adapter.apply(d.client, ZONE, desired, changes, read.unavailable)).rejects.toBeInstanceOf(StaleZoneError)
    expect(d.writes()).toEqual([])
  })

  it('is stale when a record to be created appeared meanwhile', async () => {
    const d = dns([])
    const p = profile(settings({ dmarc: DMARC }))
    const { read, desired, changes } = await preview(d.client, p)
    d.mutate((rs) => [...rs, txt('x', '_dmarc.a.com', '"v=DMARC1; p=none"')])
    await expect(adapter.apply(d.client, ZONE, desired, changes, read.unavailable)).rejects.toBeInstanceOf(StaleZoneError)
    expect(d.writes()).toEqual([])
  })

  it('never writes an unavailable area', async () => {
    const d = dns([txt('old', 'old._domainkey.a.com', '"v=DKIM1; p=old"')])
    const p = profile(settings({ spf: SPF }))
    const { desired, changes } = await preview(d.client, p)
    await adapter.apply(d.client, ZONE, desired, changes, ['dkim'])
    expect(d.writes().map((c) => c.body?.name)).toEqual(['a.com'])
    expect(d.records().some((r) => r.id === 'old')).toBe(true)
  })

  it('does nothing when everything is unchanged', async () => {
    const d = dns([txt('1', 'a.com', `"${SPF}"`)])
    await sync(d.client, profile(settings({ spf: SPF })))
    expect(d.writes()).toEqual([])
  })
})

describe('addToProfile', () => {
  const change = async (d: ReturnType<typeof dns>, p: Profile<EmailSettings>, key: string): Promise<Change> => {
    const { changes } = await preview(d.client, p)
    const c = changes.find((x) => (x.type === 'extra' ? x.actual.key : x.type === 'different' ? x.desired.key : x.entry.key) === key)
    if (!c) throw new Error('no change')
    return c
  }

  it('updates only this zone in an existing perZone record', async () => {
    const d = dns([txt('1', 's1._domainkey.a.com', '"v=DKIM1; p=new"')])
    const p = profile(settings({ dkim: [{ selector: 's1', type: 'TXT', mode: 'perZone', perZone: { z1: 'v=DKIM1; p=old', z2: 'v=DKIM1; p=two' } }] }))
    const out = adapter.addToProfile(p, ZONE, await change(d, p, 'dkim:s1'))
    expect(out.settings.dkim[0].perZone).toEqual({ z1: 'v=DKIM1; p=new', z2: 'v=DKIM1; p=two' })
  })

  it('turns a shared record into perZone without changing other zones', async () => {
    const d = dns([txt('1', 's1._domainkey.a.com', '"v=DKIM1; p=new"')])
    const base = profile(settings({ dkim: [{ selector: 's1', type: 'TXT', mode: 'shared', value: 'v=DKIM1; p=shared' }] }))
    const p = { ...base, zoneIds: ['z1', 'z2'] }
    const out = adapter.addToProfile(p, ZONE, await change(d, p, 'dkim:s1'))
    expect(out.settings.dkim[0]).toEqual({ selector: 's1', type: 'TXT', mode: 'perZone', perZone: { z1: 'v=DKIM1; p=new', z2: 'v=DKIM1; p=shared' } })
  })

  it('refuses to mix record types in one selector', async () => {
    const d = dns([cname('1', 's1._domainkey.a.com', 'x.example')])
    const p = profile(settings({ dkim: [{ selector: 's1', type: 'TXT', mode: 'shared', value: 'v=DKIM1; p=x' }] }))
    expect(() => adapter.addToProfile(p, ZONE, { type: 'different', desired: adapter.desired(p, ZONE)[0], actual: { key: 'dkim:s1', area: 'dkim', value: { type: 'CNAME', content: 'x.example', proxied: false } } })).toThrow(UserError)
  })

  it('updates the profile SPF and DMARC values, including from a duplicate', async () => {
    const d = dns([txt('1', 'a.com', '"v=spf1 -all"'), txt('2', 'a.com', '"v=spf1 +all"'), txt('3', '_dmarc.a.com', '"v=DMARC1; p=none"')])
    const p = profile(settings({ spf: SPF, dmarc: DMARC }))
    let out = adapter.addToProfile(p, ZONE, await change(d, p, 'spf'))
    expect(out.settings.spf).toBe('v=spf1 -all')
    out = adapter.addToProfile(out, ZONE, await change(d, out, 'spf#2'))
    expect(out.settings.spf).toBe('v=spf1 +all')
    out = adapter.addToProfile(out, ZONE, await change(d, out, 'dmarc'))
    expect(out.settings.dmarc).toBe('v=DMARC1; p=none')
    expect(() => parseProfile(out)).not.toThrow()
  })

  it('ignores unchanged and add changes', () => {
    const p = profile(settings({ spf: SPF }))
    const e = adapter.desired(p, ZONE)[0]
    expect(adapter.addToProfile(p, ZONE, { type: 'add', entry: e })).toBe(p)
  })
})

describe('txt helpers', () => {
  it('parses quoted chunks, escapes, and plain values', () => {
    expect(parseTxt('"v=spf1 " "-all"')).toBe('v=spf1 -all')
    expect(parseTxt('v=spf1 -all')).toBe('v=spf1 -all')
    expect(parseTxt('"a\\"b\\\\c"')).toBe('a"b\\c')
    expect(parseTxt('"unclosed')).toBe('"unclosed')
  })
  it('formats with escapes and round-trips', () => {
    const v = 'x"y\\z' + 'q'.repeat(300)
    expect(parseTxt(formatTxt(v))).toBe(v)
    expect(formatTxt('v=spf1 -all')).toBe('"v=spf1 -all"')
  })
})

describe('settings schema', () => {
  const wrap = (s: unknown) => ({ id: 'p', item: 'email', name: 'P', version: 1, zoneIds: ['z1'], settings: s, updatedAt: 't' })
  it('accepts a valid profile', () => {
    expect(() => parseProfile(wrap({ spf: SPF, dmarc: null, dkim: [{ selector: 's1', type: 'TXT', mode: 'perZone', perZone: { z1: 'v=DKIM1; p=x' } }] }))).not.toThrow()
  })
  it('rejects empty strings, wrong record kinds, unknown keys and malformed DKIM', () => {
    const bad: unknown[] = [
      { spf: '', dmarc: null, dkim: [] },
      { spf: 'hello', dmarc: null, dkim: [] },
      { spf: null, dmarc: 'v=spf1 -all', dkim: [] },
      { spf: null, dmarc: null, dkim: [], extra: 1 },
      { spf: null, dmarc: null },
      { spf: null, dmarc: null, dkim: [{ selector: 'a.b', type: 'TXT', mode: 'shared', value: 'x' }] },
      { spf: null, dmarc: null, dkim: [{ selector: 's1', type: 'MX', mode: 'shared', value: 'x' }] },
      { spf: null, dmarc: null, dkim: [{ selector: 's1', type: 'TXT', mode: 'shared' }] },
      { spf: null, dmarc: null, dkim: [{ selector: 's1', type: 'TXT', mode: 'shared', value: 'x', perZone: {} }] },
      { spf: null, dmarc: null, dkim: [{ selector: 's1', type: 'TXT', mode: 'perZone', value: 'x', perZone: {} }] },
      { spf: null, dmarc: null, dkim: [{ selector: 's1', type: 'TXT', mode: 'perZone', perZone: { z1: '' } }] },
      { spf: null, dmarc: null, dkim: [{ selector: 's1', type: 'TXT', mode: 'shared', value: 'x' }, { selector: 'S1', type: 'TXT', mode: 'shared', value: 'y' }] },
      { spf: null, dmarc: null, dkim: [{ selector: 's1', type: 'CNAME', mode: 'shared', value: 'has space' }] },
      { spf: SPF, spfTtl: 5, dmarc: null, dkim: [] }
    ]
    for (const s of bad) expect(() => parseProfile(wrap(s)), JSON.stringify(s)).toThrow()
  })
})

describe('EmailProfile screen', () => {
  it('renders the current settings', () => {
    const html = renderToStaticMarkup(
      createElement(EmailProfile, {
        settings: settings({ spf: SPF, dkim: [{ selector: 's1', type: 'TXT', mode: 'shared', value: 'v=DKIM1; p=x' }] }),
        zones: [{ id: 'z1', name: 'a.com' }],
        onChange: () => {}
      })
    )
    expect(html).toContain('include:_spf.example.com')
    expect(html).toContain('s1')
    expect(html).toContain('DMARC')
  })
})
