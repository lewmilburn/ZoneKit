import { describe, expect, it } from 'vitest'
import { CfApiError, type CfClient } from '../../src/zonekeeper/main/cloudflare/client'
import { CHILD_RULE_REF, createParentZoneHandlers } from '../../src/zonekeeper/main/parentZones'
import type { ParentLinks } from '../../src/zonekeeper/shared/ipc'

const ZONES = [{ id: 'c', name: 'child.net' }, { id: 'p', name: 'parent.com' }, { id: 'x', name: 'other.org' }]

function setup(opts: { rules?: unknown[] | null; links?: ParentLinks; profileZones?: string[]; dns?: unknown[] } = {}) {
  let links = opts.links ?? {}
  const rules = opts.rules === undefined ? null : opts.rules
  let current: { id: string; rules: unknown[] } | null = rules === null ? null : { id: 'rs', rules }
  const sends: Array<{ method: string; path: string; body?: { rules?: Array<Record<string, unknown>> } }> = []
  const client = {
    listZones: async () => ZONES,
    get: async () => {
      if (!current) throw new CfApiError(404, 'none')
      return current
    },
    getPage: async () => ({ result: opts.dns ?? [{ id: 'd1', type: 'A', name: 'child.net', proxied: true }, { id: 'd2', type: 'A', name: 'direct.child.net', proxied: false }] }),
    send: async (method: string, path: string, body?: { rules?: Array<Record<string, unknown>> }) => {
      sends.push({ method, path, body })
      return {}
    }
  } as unknown as CfClient
  const handlers = createParentZoneHandlers({
    client,
    links: {
      read: async () => links,
      set: async (child, parent) => {
        links = { ...links }
        if (parent) links[child.id] = parent.id
        else delete links[child.id]
        return links
      },
      merge: async (more) => {
        links = { ...links, ...more }
      },
      reload: () => undefined
    },
    rulesProfiles: { list: async () => [{ name: 'Base', zoneIds: opts.profileZones ?? [] }] }
  })
  return { handlers, sends, links: () => links, change: (r: unknown[]) => (current = { id: 'rs', rules: r }) }
}

const OTHER = { id: 'r1', description: 'old', expression: 'true', action: 'redirect' }

async function previewOf(h: ReturnType<typeof setup>['handlers']) {
  const r = await h.preview({ childId: 'c', parentId: 'p' })
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('parent and child zones', () => {
  it('writes one catch-all 301 keeping path and query, then links the zones', async () => {
    const s = setup()
    const p = await previewOf(s.handlers)
    const r = await s.handlers.apply({ childId: 'c', parentId: 'p', fingerprint: p.fingerprint, overwrite: false })
    expect(r.ok).toBe(true)
    const rule = s.sends[0]!.body!.rules![0]!
    expect(rule).toMatchObject({ ref: CHILD_RULE_REF, expression: 'true', action: 'redirect' })
    expect(JSON.stringify(rule)).toContain('concat(\\"https://parent.com\\", http.request.uri.path)')
    expect(JSON.stringify(rule)).toContain('"preserve_query_string":true')
    expect(s.links()).toEqual({ c: 'p' })
  })

  it('creates a proxied root when there is none, and says so in the preview', async () => {
    const s = setup({ dns: [] })
    const p = await previewOf(s.handlers)
    expect(p.dnsChange).toContain('Create a proxied root record')
    await s.handlers.apply({ childId: 'c', parentId: 'p', fingerprint: p.fingerprint, overwrite: false })
    expect(s.sends.find((x) => x.path === '/zones/c/dns_records')).toMatchObject({ method: 'POST', body: { type: 'AAAA', name: 'child.net', content: '100::', proxied: true } })
  })

  it('proxies an existing DNS-only root and changes nothing else on it', async () => {
    const s = setup({ dns: [{ id: 'd1', type: 'A', name: 'child.net', content: '1.2.3.4', proxied: false }] })
    const p = await previewOf(s.handlers)
    expect(p.dnsChange).toContain('Turn on the Cloudflare proxy')
    await s.handlers.apply({ childId: 'c', parentId: 'p', fingerprint: p.fingerprint, overwrite: false })
    expect(s.sends.find((x) => x.path === '/zones/c/dns_records/d1')).toMatchObject({ method: 'PATCH', body: { proxied: true } })
  })

  it('removing a parent deletes only the placeholder root', async () => {
    const s = setup({ rules: [], links: { c: 'p' }, dns: [{ id: 'd1', type: 'AAAA', name: 'child.net', content: '100::', proxied: true }, { id: 'd2', type: 'A', name: 'child.net', content: '1.2.3.4', proxied: true }] })
    await s.handlers.remove({ childId: 'c', confirmed: true })
    expect(s.sends).toEqual([{ method: 'DELETE', path: '/zones/c/dns_records/d1', body: undefined }])
  })

  it('warns about DNS-only records', async () => {
    const p = await previewOf(setup().handlers)
    expect(p.warnings.join()).toContain('direct.child.net')
  })

  it('never replaces other redirect rules without Overwrite', async () => {
    const s = setup({ rules: [OTHER] })
    const p = await previewOf(s.handlers)
    expect(p.conflicts).toHaveLength(1)
    expect((await s.handlers.apply({ childId: 'c', parentId: 'p', fingerprint: p.fingerprint, overwrite: false })).ok).toBe(false)
    expect(s.sends).toEqual([])
    expect((await s.handlers.apply({ childId: 'c', parentId: 'p', fingerprint: p.fingerprint, overwrite: true })).ok).toBe(true)
  })

  it('refuses when rules changed since the preview', async () => {
    const s = setup({ rules: [OTHER] })
    const p = await previewOf(s.handlers)
    s.change([{ ...OTHER, expression: 'false' }])
    expect((await s.handlers.apply({ childId: 'c', parentId: 'p', fingerprint: p.fingerprint, overwrite: true })).ok).toBe(false)
    expect(s.sends).toEqual([])
  })

  it('refuses invalid structures', async () => {
    expect((await setup().handlers.preview({ childId: 'c', parentId: 'c' })).ok).toBe(false)
    expect((await setup({ links: { p: 'x' } }).handlers.preview({ childId: 'c', parentId: 'p' })).ok).toBe(false)
    expect((await setup({ links: { x: 'c' } }).handlers.preview({ childId: 'c', parentId: 'p' })).ok).toBe(false)
    expect((await setup({ profileZones: ['c'] }).handlers.preview({ childId: 'c', parentId: 'p' })).ok).toBe(false)
  })

  it('removal deletes only its own rule', async () => {
    const s = setup({ rules: [OTHER, { id: 'mine', ref: CHILD_RULE_REF }], links: { c: 'p' } })
    expect((await s.handlers.remove({ childId: 'c', confirmed: true })).ok).toBe(true)
    expect(s.sends).toEqual([{ method: 'DELETE', path: '/zones/c/rulesets/rs/rules/mine', body: undefined }])
    expect(s.links()).toEqual({})
  })
})
