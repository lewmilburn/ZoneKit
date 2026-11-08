import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { errorText } from '../shared/errorText'
import type { IpcResult, ParentLinks, ParentPreview } from '../shared/ipc'
import { CfApiError, type CfClient, type Zone } from './cloudflare/client'
import { UserError } from './errors'
import { hash } from './items/rules'

export const CHILD_RULE_REF = 'zonekeeper-parent-redirect'
const PHASE = 'http_request_dynamic_redirect'

export interface LinkStore {
  read(): Promise<ParentLinks>
  set(child: Zone, parent: Zone | null): Promise<ParentLinks>
  /** Adds or replaces these links, for import. */
  merge(links: ParentLinks): Promise<void>
  /** Forgets the cached copy, after the file is replaced. */
  reload(): void
}

/** Child zone id to parent zone id, in a local file. */
export function fileLinkStore(filePath: string, onWrite: () => void = () => undefined): LinkStore {
  let loading: Promise<ParentLinks> | null = null
  let chain: Promise<unknown> = Promise.resolve()

  async function load(): Promise<ParentLinks> {
    try {
      const json = JSON.parse(await readFile(filePath, 'utf8')) as unknown
      if (json && typeof json === 'object' && !Array.isArray(json)) return json as ParentLinks
      throw new Error(`The parent links file is corrupt and was left untouched: ${filePath}`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      return {}
    }
  }
  async function save(links: ParentLinks): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(links, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, filePath)
    } catch (e) {
      await unlink(tmp).catch(() => undefined)
      throw e
    }
    onWrite()
  }
  // Callers at the same time share one load
  const read = (): Promise<ParentLinks> => {
    loading ??= load().catch((e: unknown) => {
      loading = null
      throw e
    })
    return loading
  }
  const update = (change: (links: ParentLinks) => void): Promise<ParentLinks> => {
    const run = chain.then(async () => {
      const links = { ...(await read()) }
      change(links)
      await save(links)
      loading = Promise.resolve(links)
      return links
    })
    chain = run.catch(() => undefined)
    return run
  }
  return {
    read,
    set: (child, parent) =>
      update((links) => {
        if (parent) links[child.id] = parent.id
        else delete links[child.id]
      }),
    merge: async (incoming) => void (await update((links) => Object.assign(links, incoming))),
    reload: () => {
      loading = null
    }
  }
}

export interface ParentZoneDeps {
  client: Pick<CfClient, 'get' | 'getPage' | 'send' | 'listZones'>
  links: LinkStore
  rulesProfiles: { list(item: 'rules'): Promise<Array<{ name: string; zoneIds: string[] }>> }
}

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const previewInput = z.strictObject({ childId: id, parentId: id })
const applyInput = z.strictObject({ childId: id, parentId: id, fingerprint: z.string().regex(/^[a-f0-9]{32}$/), overwrite: z.boolean() })
const removeInput = z.strictObject({ childId: id, confirmed: z.literal(true) })

interface RawRule {
  id: string
  ref?: string
  description?: string
  expression?: string
  action?: string
  action_parameters?: unknown
  enabled?: boolean
}
interface RawDns {
  id: string
  type: string
  name: string
  content?: string
  proxied?: boolean
}
/** Cloudflare's placeholder for a rules-only hostname. */
const PLACEHOLDER_ROOT = { type: 'AAAA', content: '100::' }

interface RawRuleset {
  id: string
  rules?: RawRule[]
}

function describe(e: unknown): string {
  if (e instanceof UserError) return e.message
  if (e instanceof CfApiError) {
    if (e.status === 401) return 'Cloudflare rejected your API token.'
    if (e.status === 403) return 'Your token needs the Single Redirect and DNS permissions for this zone.'
    if (e.status === 0) return "Couldn't reach Cloudflare, check your connection."
  }
  return errorText(e)
}

/** Keeps the path and query. */
export function childRule(parentName: string): Record<string, unknown> {
  return {
    ref: CHILD_RULE_REF,
    description: `Redirect all traffic to parent zone ${parentName}`,
    expression: 'true',
    action: 'redirect',
    action_parameters: {
      from_value: {
        status_code: 301,
        preserve_query_string: true,
        target_url: { expression: `concat("https://${parentName}", http.request.uri.path)` }
      }
    },
    enabled: true
  }
}

export function createParentZoneHandlers(deps: ParentZoneDeps) {
  async function readRuleset(zoneId: string): Promise<RawRuleset | null> {
    try {
      return await deps.client.get<RawRuleset>(`/zones/${zoneId}/rulesets/phases/${PHASE}/entrypoint`)
    } catch (e) {
      if (e instanceof CfApiError && e.status === 404) return null
      throw e
    }
  }

  const others = (r: RawRuleset | null): RawRule[] => (r?.rules ?? []).filter((x) => x.ref !== CHILD_RULE_REF)
  const fingerprintOf = (r: RawRuleset | null): string =>
    hash((r?.rules ?? []).map((x) => ({ id: x.id, ref: x.ref ?? null, expression: x.expression ?? null, action: x.action ?? null, parameters: x.action_parameters ?? null, enabled: x.enabled ?? null })))

  async function zonesFor(childId: string, parentId: string): Promise<{ child: Zone; parent: Zone }> {
    if (childId === parentId) throw new UserError('A zone cannot be its own parent.')
    const zones = await deps.client.listZones()
    const child = zones.find((z) => z.id === childId)
    const parent = zones.find((z) => z.id === parentId)
    if (!child || !parent) throw new UserError('That zone was not found for this token.')
    const links = await deps.links.read()
    if (links[parentId]) throw new UserError(`${parent.name} is a child zone, so it cannot be a parent.`)
    if (Object.values(links).includes(childId)) throw new UserError(`${child.name} is a parent zone, so it cannot be a child.`)
    const profile = (await deps.rulesProfiles.list('rules')).find((p) => p.zoneIds.includes(childId))
    if (profile) throw new UserError(`${child.name} is in the Rules profile "${profile.name}". Remove it from that profile first, because their redirects would compete.`)
    return { child, parent }
  }

  async function webRecords(zone: Zone): Promise<RawDns[]> {
    const qs = new URLSearchParams({ per_page: '1000' })
    const { result } = await deps.client.getPage<RawDns[]>(`/zones/${zone.id}/dns_records?${qs}`)
    return result.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type))
  }

  const rootOf = (zone: Zone, web: RawDns[]): RawDns[] => web.filter((r) => r.name === zone.name)

  function dnsChange(zone: Zone, web: RawDns[]): string | null {
    const root = rootOf(zone, web)
    if (root.some((r) => r.proxied === true)) return null
    if (root.length === 0) return `Create a proxied root record for ${zone.name}, so visitors reach this redirect.`
    return `Turn on the Cloudflare proxy for the ${zone.name} root record, so visitors reach this redirect instead of its current server.`
  }

  /** Proxies the root, as shown in the preview. */
  async function ensureProxiedRoot(zone: Zone): Promise<void> {
    const root = rootOf(zone, await webRecords(zone))
    if (root.some((r) => r.proxied === true)) return
    const path = `/zones/${zone.id}/dns_records`
    if (root.length === 0) await deps.client.send('POST', path, { ...PLACEHOLDER_ROOT, name: zone.name, proxied: true, ttl: 1 })
    else for (const r of root) await deps.client.send('PATCH', `${path}/${encodeURIComponent(r.id)}`, { proxied: true })
  }

  async function removePlaceholderRoot(zone: Zone): Promise<void> {
    const path = `/zones/${zone.id}/dns_records`
    for (const r of rootOf(zone, await webRecords(zone))) {
      if (r.type === PLACEHOLDER_ROOT.type && r.content === PLACEHOLDER_ROOT.content) await deps.client.send('DELETE', `${path}/${encodeURIComponent(r.id)}`)
    }
  }

  return {
    async links(): Promise<IpcResult<ParentLinks>> {
      try {
        return { ok: true, value: await deps.links.read() }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async preview(raw: unknown): Promise<IpcResult<ParentPreview>> {
      const input = previewInput.safeParse(raw)
      if (!input.success) return { ok: false, error: 'That request was not valid.' }
      try {
        const { child, parent } = await zonesFor(input.data.childId, input.data.parentId)
        const ruleset = await readRuleset(child.id)
        const web = await webRecords(child)
        const unproxied = web.filter((r) => r.proxied !== true && r.name !== child.name).map((r) => r.name)
        return {
          ok: true,
          value: {
            childId: child.id,
            parentId: parent.id,
            childName: child.name,
            parentName: parent.name,
            fingerprint: fingerprintOf(ruleset),
            conflicts: others(ruleset).map((r) => ({ description: r.description ?? '', expression: r.expression ?? '' })),
            dnsChange: dnsChange(child, web),
            warnings: unproxied.length > 0 ? [`These DNS-only records won't redirect, because their traffic doesn't pass through Cloudflare: ${unproxied.join(', ')}`] : []
          }
        }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async apply(raw: unknown): Promise<IpcResult<ParentLinks>> {
      const input = applyInput.safeParse(raw)
      if (!input.success) return { ok: false, error: 'That request was not valid.' }
      const i = input.data
      try {
        const { child, parent } = await zonesFor(i.childId, i.parentId)
        const ruleset = await readRuleset(child.id)
        if (fingerprintOf(ruleset) !== i.fingerprint) throw new UserError('Redirect rules on this zone changed, preview again.')
        if (others(ruleset).length > 0 && !i.overwrite) throw new UserError('This zone has other redirect rules, choose Overwrite or Cancel sync.')
        const rules = [childRule(parent.name)]
        if (ruleset) await deps.client.send('PUT', `/zones/${child.id}/rulesets/phases/${PHASE}/entrypoint`, { rules })
        else await deps.client.send('POST', `/zones/${child.id}/rulesets`, { name: `Zonekeeper ${PHASE}`, kind: 'zone', phase: PHASE, rules })
        await ensureProxiedRoot(child)
        return { ok: true, value: await deps.links.set(child, parent) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    },

    async remove(raw: unknown): Promise<IpcResult<ParentLinks>> {
      const input = removeInput.safeParse(raw)
      if (!input.success) return { ok: false, error: 'That request was not valid.' }
      const { childId } = input.data
      try {
        const ruleset = await readRuleset(childId)
        const rule = ruleset?.rules?.find((r) => r.ref === CHILD_RULE_REF)
        if (ruleset && rule) await deps.client.send('DELETE', `/zones/${childId}/rulesets/${ruleset.id}/rules/${rule.id}`)
        const child = (await deps.client.listZones()).find((z) => z.id === childId)
        if (!child) throw new UserError('That zone was not found for this token.')
        await removePlaceholderRoot(child)
        return { ok: true, value: await deps.links.set(child, null) }
      } catch (e) {
        return { ok: false, error: describe(e) }
      }
    }
  }
}
