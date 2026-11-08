import { plural } from '@app/shared/plural'
import { createHash } from 'node:crypto'
import { errorText } from '../../shared/errorText'
import { diffEntries, stripServerFields } from '../../shared/diff'
import type { Change, Entry, Profile } from '../../shared/model'
import { abstractZone, resolveZone } from '../../shared/placeholder'
import {
  MANAGED_WWW_REF_PREFIX,
  RULES_PHASES,
  type BulkRedirect,
  type PageRule,
  type Rule,
  type RulesPhase,
  type RulesSettings
} from '../../shared/schemas'
import { SECURITY_HEADER_REF_PREFIX } from '../../shared/securityHeaders'
import { CfApiError, type CfClient, type Zone } from '../cloudflare/client'
import { StaleZoneError, UserError, ZoneNotWrittenError } from '../errors'
import type { ListSnapshotStore } from '../store/listSnapshots'
import type { ItemAdapter, ReadResult } from '../sync/adapter'

export { MANAGED_WWW_REF_PREFIX, RULES_PHASES }

const PAGE_RULES = 'pageRules'
const BULK = 'bulkRedirects'
const REDIRECT_PHASE = 'http_request_redirect'
const TRANSFORM_PHASES: readonly string[] = ['http_request_late_transform', 'http_response_headers_transform']
const MAX_LIST_PAGES = 1000
const OPERATION_POLLS = 120
const OPERATION_POLL_MS = 1000

const SSL_ACTIONS = new Set(['ssl', 'always_use_https', 'automatic_https_rewrites', 'opportunistic_encryption'])
const CACHE_ACTIONS = new Set([
  'cache_level',
  'edge_cache_ttl',
  'browser_cache_ttl',
  'cache_key_fields',
  'cache_deception_armor',
  'cache_on_cookie',
  'cache_by_device_type',
  'bypass_cache_on_cookie',
  'origin_cache_control',
  'respect_strong_etag',
  'explicit_cache_control',
  'sort_query_string_for_cache',
  'cache_ttl_by_status'
])

/** Mixed or unknown actions stay with Rules. */
export function classifyPageRule(rule: { actions?: Array<{ id?: unknown; [key: string]: unknown }> }): 'rules' | 'ssl' | 'caching' {
  const ids = (rule.actions ?? []).map((a) => String(a.id))
  if (ids.length === 0) return 'rules'
  if (ids.every((id) => SSL_ACTIONS.has(id))) return 'ssl'
  if (ids.every((id) => CACHE_ACTIONS.has(id))) return 'caching'
  return 'rules'
}

/** Each Page Rule has exactly one owning item. */
export function ownsPageRule(item: 'rules' | 'ssl' | 'caching', rule: Parameters<typeof classifyPageRule>[0]): boolean {
  return classifyPageRule(rule) === item
}

export type RawRule = Record<string, unknown> & { id?: string; ref?: string; enabled?: boolean }
interface RawPageRule extends PageRule {
  id: string
  priority: number
}
interface RawItem extends BulkRedirect {
  id: string
}
interface RawList {
  id: string
  name: string
  kind?: string
}

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted)
  if (typeof v !== 'object' || v === null) return v
  const o = v as Record<string, unknown>
  return Object.keys(o)
    .sort()
    .map((k) => [k, sorted(o[k])])
}

/** Ignores key order. */
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex').slice(0, 32)
}

/** #2, #3 mark identical entries. */
function uniqueKey(seen: Map<string, number>, key: string): string {
  const n = (seen.get(key) ?? 0) + 1
  seen.set(key, n)
  return n === 1 ? key : `${key}#${n}`
}

function isExcluded(phase: string, rule: RawRule): boolean {
  if (typeof rule.ref === 'string' && (rule.ref.startsWith(MANAGED_WWW_REF_PREFIX) || rule.ref.startsWith(SECURITY_HEADER_REF_PREFIX))) return true
  const params = rule.action_parameters as Record<string, unknown> | undefined
  return TRANSFORM_PHASES.includes(phase) && params?.uri !== undefined
}

/** A ref equal to the id is Cloudflare's default, not a real ref. */
function normaliseRule(rule: RawRule): Record<string, unknown> {
  const out: Record<string, unknown> = stripServerFields({ ...rule })
  if (rule.ref === rule.id) delete out.ref
  out.enabled = rule.enabled ?? true
  return out
}

export function ruleEntries(phase: string, rules: RawRule[]): Array<Entry & { source: RawRule }> {
  const seen = new Map<string, number>()
  return rules
    .filter((r) => !isExcluded(phase, r))
    .map((source, order) => {
      const value = normaliseRule(source)
      const key = typeof value.ref === 'string' ? `${phase}:ref:${value.ref}` : `${phase}:hash:${hash(value)}`
      return { key: uniqueKey(seen, key), area: phase, value, order, source }
    })
}

/** Marks rules a profile wrote, others are the zone's own and never synced. */
export const PROFILE_REF = 'zkp_'
const refPrefix = (profileId: string): string => `${PROFILE_REF}${profileId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}_`
const refOf = (v: unknown): string | undefined => {
  const ref = (v as { ref?: unknown } | null)?.ref
  return typeof ref === 'string' ? ref : undefined
}
/** Ignores ref and id. */
function ruleContent(v: unknown): string {
  const { ref: _r, id: _i, ...rest } = v as Record<string, unknown>
  return hash(rest)
}

/** Adds a profile ref to rules without one. */
export function profileRuleEntries(phase: string, rules: RawRule[], profileId: string): Entry[] {
  const seen = new Map<string, number>()
  return rules
    .filter((r) => !isExcluded(phase, r))
    .map((rule, order) => {
      const value = normaliseRule(rule)
      if (refOf(value) === undefined) {
        const base = `${refPrefix(profileId)}${ruleContent(value).slice(0, 16)}`
        const n = (seen.get(base) ?? 0) + 1
        seen.set(base, n)
        value.ref = n === 1 ? base : `${base}_${n}`
      }
      return { key: `${phase}:ref:${refOf(value)}`, area: phase, value, order }
    })
}

/** By ref, or by content for rules synced before refs. */
export function matchesRule(entry: Entry, rule: RawRule): boolean {
  const ref = refOf(normaliseRule(rule))
  if (ref !== undefined && ref === refOf(entry.value)) return true
  return (ref === undefined || !ref.startsWith(PROFILE_REF)) && ruleContent(normaliseRule(rule)) === ruleContent(entry.value)
}

/** Only rules this profile manages. */
export function ownedRuleEntries(phase: string, fresh: RawRule[], desired: Entry[], profileId: string): Entry[] {
  const prefix = refPrefix(profileId)
  const wanted = desired.filter((d) => d.area === phase)
  const refs = new Set(wanted.flatMap((d) => refOf(d.value) ?? []))
  const unclaimed = [...wanted]
  const out: Entry[] = []
  let order = 0
  for (const rule of fresh) {
    if (isExcluded(phase, rule)) continue
    const value = normaliseRule(rule)
    const ref = refOf(value)
    if (ref !== undefined && (ref.startsWith(PROFILE_REF) || refs.has(ref))) {
      const at = order++
      if (ref.startsWith(prefix) || refs.has(ref)) out.push({ key: `${phase}:ref:${ref}`, area: phase, value, order: at })
      continue
    }
    // Synced before refs existed
    const i = unclaimed.findIndex((d) => ruleContent(d.value) === ruleContent(value))
    if (i >= 0) {
      const [match] = unclaimed.splice(i, 1)
      out.push({ ...(match as Entry), order: order++ })
    }
  }
  return out
}

export const ownsRuleEntry = (e: Entry): boolean => refOf(e.value)?.startsWith(PROFILE_REF) ?? false

/** Every rule the preview saw must be unchanged. */
export function assertRulesUnchangedSince(changes: Change[], phase: string, fresh: RawRule[]): void {
  const live = fresh.filter((r) => !isExcluded(phase, r)).map((r) => ruleContent(normaliseRule(r)))
  for (const c of changes) {
    const e = c.type === 'unchanged' ? c.entry : c.type === 'different' || c.type === 'extra' ? c.actual : undefined
    if (e && e.area === phase && !live.includes(ruleContent(e.value))) {
      throw new StaleZoneError(`${phase} changed during this sync, start a new preview.`)
    }
  }
}

function plainEntry(e: Entry): Entry {
  return { key: e.key, area: e.area, value: e.value, order: e.order }
}

function pageRuleEntries(rules: PageRule[]): Array<Entry & { index: number }> {
  const seen = new Map<string, number>()
  return rules.map((r, order) => {
    const value = { targets: r.targets, actions: r.actions, status: r.status ?? 'active' }
    return { key: uniqueKey(seen, `${PAGE_RULES}:${hash(value)}`), area: PAGE_RULES, value, order, index: order }
  })
}

function ownPageRules(raw: RawPageRule[]): RawPageRule[] {
  return raw.filter((r) => classifyPageRule(r) === 'rules').sort((a, b) => b.priority - a.priority)
}

function sourceHost(sourceUrl: string): string | undefined {
  try {
    return new URL(sourceUrl.includes('://') ? sourceUrl : `https://${sourceUrl}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** Zone or www only: other subdomains may be separate zones. */
function hostMatches(sourceUrl: string, zoneName: string): boolean {
  const zone = zoneName.toLowerCase()
  const host = sourceHost(sourceUrl)
  return host === zone || host === `www.${zone}`
}

function isSkippedSubdomain(sourceUrl: string, zoneName: string): boolean {
  return !hostMatches(sourceUrl, zoneName) && (sourceHost(sourceUrl)?.endsWith(`.${zoneName.toLowerCase()}`) ?? false)
}

function sameItem(a: BulkRedirect, b: BulkRedirect): boolean {
  return diffEntries([bulkEntry('', a)], [bulkEntry('', b)])[0].type === 'unchanged'
}

function describeFailure(e: unknown): string {
  return errorText(e)
}

function bulkEntry(list: string, item: BulkRedirect): Entry {
  const r = item.redirect
  const redirect = {
    source_url: r.source_url,
    target_url: r.target_url,
    status_code: r.status_code ?? 301,
    include_subdomains: r.include_subdomains ?? false,
    subpath_matching: r.subpath_matching ?? false,
    preserve_query_string: r.preserve_query_string ?? false,
    preserve_path_suffix: r.preserve_path_suffix ?? true
  }
  return {
    key: `${BULK}:${list}:${r.source_url}`,
    area: BULK,
    value: { list, redirect, ...(item.comment === undefined ? {} : { comment: item.comment }) }
  }
}

/** Present when the list is on. */
function activeEntry(list: string): Entry {
  return { key: `${BULK}:active:${list}`, area: BULK, value: { list, active: true } }
}

function isActiveEntry(e: Entry): boolean {
  return (e.value as { active?: boolean }).active === true
}

function listRule(rules: RawRule[], list: string): RawRule | undefined {
  const named = rules.filter((r) => (r.action_parameters as { from_list?: { name?: string } } | undefined)?.from_list?.name === list)
  return named.find((r) => r.enabled !== false) ?? named[0]
}

export async function orUnavailable<T>(work: () => Promise<T>): Promise<{ value: T } | 'unavailable'> {
  try {
    return { value: await work() }
  } catch (e) {
    if (e instanceof CfApiError && e.status === 403) return 'unavailable'
    throw e
  }
}

/** Null on 404 only. */
export async function readEntrypoint(client: CfClient, scope: string, phase: string): Promise<RawRule[] | null> {
  let ruleset: unknown
  try {
    ruleset = await client.get(`/${scope}/rulesets/phases/${phase}/entrypoint`)
  } catch (e) {
    if (e instanceof CfApiError && e.status === 404) return null
    throw e
  }
  const rules = (ruleset as { rules?: unknown } | null)?.rules
  if (ruleset === null || typeof ruleset !== 'object' || (rules !== undefined && !Array.isArray(rules))) {
    throw new UserError(`Cloudflare returned an unexpected ruleset for ${phase}.`)
  }
  return (rules as RawRule[] | undefined) ?? []
}

async function readPageRules(client: CfClient, zone: Zone): Promise<RawPageRule[]> {
  const rules = await client.get<RawPageRule[]>(`/zones/${zone.id}/pagerules`)
  if (!Array.isArray(rules)) throw new UserError('Cloudflare returned an unexpected Page Rules list.')
  return rules
}

async function findList(client: CfClient, account: string, name: string): Promise<RawList | undefined> {
  const lists = await client.get<RawList[]>(`/accounts/${account}/rules/lists`)
  if (!Array.isArray(lists)) throw new UserError('Cloudflare returned an unexpected lists response.')
  return lists.find((l) => l.name === name && l.kind === 'redirect')
}

/** Throws rather than return part of a list. */
async function readItems(client: CfClient, account: string, listId: string): Promise<RawItem[]> {
  const items: RawItem[] = []
  const used = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
    const { result, after } = await client.getPage<RawItem[]>(`/accounts/${account}/rules/lists/${listId}/items${query}`)
    if (!Array.isArray(result)) throw new UserError('Cloudflare returned an unexpected list items response.')
    items.push(...result)
    if (!after) return items
    if (used.has(after)) throw new UserError('Cloudflare returned a repeated page of list items.')
    used.add(after)
    cursor = after
  }
  throw new UserError('Too many pages while reading list items.')
}

function requireAccount(zone: Zone): string {
  const id = zone.account?.id
  if (!id) throw new UserError(`The account for ${zone.name} is not known, so its Bulk Redirects can't be read.`)
  return id
}

/** A difference means an unseen edit. */
export function assertUnchangedSince(changes: Change[], area: string, fresh: Entry[]): void {
  const expected = changes.flatMap((c) => {
    const e = c.type === 'add' ? undefined : 'entry' in c ? c.entry : c.actual
    return e && e.area === area && !isActiveEntry(e) ? [e] : []
  })
  if (!diffEntries(expected, fresh).every((c) => c.type === 'unchanged')) {
    throw new StaleZoneError(`${area} changed during this sync, start a new preview.`)
  }
}

function hasChanges(changes: Change[], area: string): boolean {
  return changes.some((c) => {
    if (c.type === 'unchanged') return false
    return ('entry' in c ? c.entry : 'desired' in c ? c.desired : c.actual).area === area
  })
}

/** Rewrites profile slots only, the zone's own rules keep their place. */
export function buildPhaseRules(phase: string, fresh: RawRule[], desired: Entry[]): Record<string, unknown>[] {
  const refs = new Set(desired.flatMap((d) => refOf(d.value) ?? []))
  const unclaimed = [...desired]
  const ids = new Map<string, string>()
  const slot = fresh.map((rule) => {
    if (isExcluded(phase, rule)) return false
    const ref = refOf(normaliseRule(rule))
    if (ref !== undefined && (ref.startsWith(PROFILE_REF) || refs.has(ref))) {
      const d = desired.find((x) => refOf(x.value) === ref)
      if (d && typeof rule.id === 'string') ids.set(d.key, rule.id)
      return true
    }
    // Synced before refs existed
    const i = unclaimed.findIndex((d) => !fresh.some((r) => refOf(r) === refOf(d.value)) && matchesRule(d, rule))
    if (i < 0) return false
    const [d] = unclaimed.splice(i, 1)
    if (d && typeof rule.id === 'string') ids.set(d.key, rule.id)
    return true
  })
  const next = desired.map((d) => {
    const id = ids.get(d.key)
    return { ...(d.value as Record<string, unknown>), ...(id === undefined ? {} : { id }) }
  })
  const out: Record<string, unknown>[] = []
  let used = 0
  fresh.forEach((rule, i) => {
    if (!slot[i]) {
      const { version: _v, last_updated: _l, ...kept } = rule
      out.push(kept)
    } else if (used < next.length) {
      out.push(next[used++] as Record<string, unknown>)
    }
  })
  out.push(...next.slice(used))
  return out
}

export async function writeEntrypoint(
  client: CfClient,
  scope: string,
  kind: 'zone' | 'root',
  phase: string,
  exists: boolean,
  rules: unknown[]
): Promise<void> {
  if (exists) await client.send('PUT', `/${scope}/rulesets/phases/${phase}/entrypoint`, { rules })
  else await client.send('POST', `/${scope}/rulesets`, { name: `Zonekeeper ${phase}`, kind, phase, rules })
}

async function applyPhase(client: CfClient, zone: Zone, phase: RulesPhase, desired: Entry[], changes: Change[]): Promise<void> {
  const scope = `zones/${zone.id}`
  const fresh = await readEntrypoint(client, scope, phase)
  assertRulesUnchangedSince(changes, phase, fresh ?? [])
  const wanted = desired.filter((d) => d.area === phase).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  await writeEntrypoint(client, scope, 'zone', phase, fresh !== null, buildPhaseRules(phase, fresh ?? [], wanted))
}

async function applyPageRules(client: CfClient, zone: Zone, desired: Entry[], changes: Change[]): Promise<void> {
  const base = `/zones/${zone.id}/pagerules`
  const all = await readPageRules(client, zone)
  const own = ownPageRules(all)
  const entries = pageRuleEntries(own)
  assertUnchangedSince(changes, PAGE_RULES, entries.map(plainEntry))
  const rowByKey = new Map(entries.map((e) => [e.key, own[e.index]]))
  const wanted = desired.filter((d) => d.area === PAGE_RULES).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const wantedKeys = new Set(wanted.map((d) => d.key))

  // Reuse slots to keep priority against other items' rules
  const needed = wanted.length - own.length
  const top = Math.max(0, ...all.map((r) => r.priority))
  const fresh = Array.from({ length: Math.max(needed, 0) }, (_, i) => top + Math.max(needed, 0) - i)
  const slots = [...fresh, ...own.map((r) => r.priority)]

  const unchanged = new Set(changes.flatMap((c) => (c.type === 'unchanged' ? [c.entry.key] : [])))
  for (const [i, d] of wanted.entries()) {
    const body = { ...(d.value as object), priority: slots[i] }
    const row = rowByKey.get(d.key)
    if (!row) await client.send('POST', base, body)
    else if (!unchanged.has(d.key) || row.priority !== slots[i]) await client.send('PUT', `${base}/${row.id}`, body)
  }
  // Deletes last, so a failed write loses nothing
  for (const e of entries) {
    if (!wantedKeys.has(e.key)) await client.send('DELETE', `${base}/${own[e.index].id}`)
  }
}

export interface RulesAdapterDeps {
  sleep?: (ms: number) => Promise<void>
  /** Backup before replacing a shared list. */
  snapshots: ListSnapshotStore
  phases?: readonly RulesPhase[]
}

function withoutServerFields(row: object): Record<string, unknown> {
  const { id: _id, created_on: _c, modified_on: _m, ...rest } = row as Record<string, unknown>
  return rest
}

/** Order-independent. */
function sameRows(a: object[], b: object[]): boolean {
  const canon = (rows: object[]): string[] => rows.map((r) => JSON.stringify(sorted(withoutServerFields(r)))).sort()
  const [x, y] = [canon(a), canon(b)]
  return x.length === y.length && x.every((v, i) => v === y[i])
}

async function waitForOperation(client: CfClient, account: string, result: unknown, sleep: (ms: number) => Promise<void>): Promise<void> {
  const id = (result as { operation_id?: unknown } | null)?.operation_id
  if (typeof id !== 'string') throw new UserError('Cloudflare did not return an operation to follow for this list change.')
  for (let i = 0; i < OPERATION_POLLS; i++) {
    const op = await client.get<{ status?: string; error?: unknown }>(`/accounts/${account}/rules/lists/bulk_operations/${encodeURIComponent(id)}`)
    if (op?.status === 'completed') return
    if (op?.status === 'failed') {
      const detail = typeof op.error === 'string' && op.error ? `: ${op.error.slice(0, 500)}` : '.'
      throw new UserError(`A Bulk Redirects list change did not complete${detail}`)
    }
    await sleep(OPERATION_POLL_MS)
  }
  throw new UserError("A Bulk Redirects list change didn't finish in time, check the list.")
}

async function applyBulk(
  client: CfClient,
  zone: Zone,
  desired: Entry[],
  changes: Change[],
  sleep: (ms: number) => Promise<void>,
  snapshots: ListSnapshotStore
): Promise<void> {
  const account = requireAccount(zone)
  const scope = `accounts/${account}`
  const touched = changes.flatMap((c) => ('entry' in c ? [c.entry] : 'desired' in c ? [c.desired, c.actual] : [c.actual]))
  const listName = touched.filter((e) => e.area === BULK).map((e) => (e.value as { list: string }).list)[0]
  if (listName === undefined) return

  const list = await findList(client, account, listName)
  const items = list ? await readItems(client, account, list.id) : []
  const ours = items.filter((i) => hostMatches(i.redirect.source_url, zone.name))
  assertUnchangedSince(changes, BULK, ours.map((i) => bulkEntry(listName, i)))

  // Turning a list on affects other zones too
  const activate = changes.some((c) => c.type === 'add' && c.entry.area === BULK && isActiveEntry(c.entry))
  if (activate && items.length > ours.length) {
    const existing = listRule((await readEntrypoint(client, scope, REDIRECT_PHASE)) ?? [], listName)
    if (existing?.enabled === false || !existing) {
      throw new ZoneNotWrittenError(`Enabling the list "${listName}" would change other zones' redirects, so nothing was written.`)
    }
  }

  const toItem = (e: Entry): BulkRedirect => {
    const { redirect, comment } = e.value as BulkRedirect
    return { redirect, ...(comment === undefined ? {} : { comment }) }
  }
  const bulkOnly = (e: Entry): boolean => e.area === BULK && !isActiveEntry(e)
  const additions = changes.flatMap((c) => (c.type === 'add' && bulkOnly(c.entry) ? [toItem(c.entry)] : []))
  const replacements = changes.flatMap((c) => (c.type === 'different' && bulkOnly(c.desired) ? [toItem(c.desired)] : []))
  const extras = changes.flatMap((c) => (c.type === 'extra' && bulkOnly(c.actual) ? [toItem(c.actual)] : []))

  let listId = list?.id
  if (!listId && additions.length + replacements.length > 0) {
    const created = await client.send<RawList>('POST', `/${scope}/rules/lists`, { name: listName, kind: 'redirect', description: 'Managed by Zonekeeper' })
    listId = created?.id
    if (!listId) throw new UserError('Cloudflare did not return the new list.')
  }
  const itemsPath = `/${scope}/rules/lists/${listId}/items`
  if (replacements.length > 0) {
    // No single-item update exists, so the whole list is replaced from a fresh read
    const latest = await readItems(client, account, listId as string)
    assertUnchangedSince(changes, BULK, latest.filter((i) => hostMatches(i.redirect.source_url, zone.name)).map((i) => bulkEntry(listName, i)))
    const removed = new Set(extras.map((x) => x.redirect.source_url))
    const bySource = new Map(replacements.map((r) => [r.redirect.source_url, r]))
    const body = [
      ...latest.flatMap((row) => {
        if (hostMatches(row.redirect.source_url, zone.name)) {
          if (removed.has(row.redirect.source_url)) return []
          const next = bySource.get(row.redirect.source_url)
          if (next) return [next]
        }
        return [withoutServerFields(row)]
      }),
      ...additions
    ]
    // Not documented as atomic, so back up first
    let snapshot: string
    try {
      snapshot = await snapshots.save(account, listId as string, latest)
    } catch {
      throw new ZoneNotWrittenError(`A copy of the list "${listName}" could not be saved, so nothing was written.`)
    }
    const sources = replacements.map((r) => r.redirect.source_url).join(', ')
    const reach = `A backup of the list is saved as snapshot ${snapshot}.`
    try {
      await waitForOperation(client, account, await client.send('PUT', itemsPath, body), sleep)
    } catch (e) {
      throw new UserError(`The list update for ${sources} did not complete: ${describeFailure(e)} ${reach}`)
    }
    let after: RawItem[]
    try {
      after = await readItems(client, account, listId as string)
    } catch (e) {
      throw new UserError(`The list update for ${sources} finished, but the list could not be read back to check it: ${describeFailure(e)} ${reach}`)
    }
    if (!sameRows(after, body)) {
      throw new UserError(`The list update for ${sources} finished, but the list doesn't match what was sent. ${reach}`)
    }
  } else {
    // Writes before deletes
    if (additions.length > 0) await waitForOperation(client, account, await client.send('POST', itemsPath, additions), sleep)
    const rows = additions.length > 0 && listId ? await readItems(client, account, listId) : items
    const zoneRows = rows.filter((i) => hostMatches(i.redirect.source_url, zone.name))
    const missing = additions.filter((want) => !zoneRows.some((r) => sameItem(r, want)))
    if (missing.length > 0) {
      const sources = missing.map((r) => r.redirect.source_url).join(', ')
      throw new UserError(`Cloudflare accepted the change, but the list doesn't show ${sources}.`)
    }
    const staleRows = zoneRows.filter((r) => extras.some((x) => x.redirect.source_url === r.redirect.source_url))
    if (staleRows.length > 0) {
      const body = { items: staleRows.map((r) => ({ id: r.id })) }
      await waitForOperation(client, account, await client.send('DELETE', itemsPath, body), sleep)
    }
  }

  if (activate && listId) {
    // Re-read: polling can take minutes
    const rules = await readEntrypoint(client, scope, REDIRECT_PHASE)
    const current = rules ?? []
    const existing = listRule(current, listName)
    if (existing?.enabled !== false && existing) return
    const kept = current.map((r) => {
      const { version: _v, last_updated: _l, ...rest } = r
      return r === existing ? { ...rest, enabled: true } : rest
    })
    if (!existing) {
      kept.push({
        ref: `zonekeeper_${listName}`,
        expression: `http.request.full_uri in $${listName}`,
        action: 'redirect',
        enabled: true,
        action_parameters: { from_list: { name: listName, key: 'http.request.full_uri' } }
      })
    }
    await writeEntrypoint(client, scope, 'root', REDIRECT_PHASE, rules !== null, kept)
  }
}

function insertAt<T>(list: T[], index: number, value: T): T[] {
  const at = Math.min(Math.max(index, 0), list.length)
  return [...list.slice(0, at), value, ...list.slice(at)]
}

/** Moves or replaces the entry with the same key. */
function merged<T>(list: T[], entries: Entry[], key: string, order: number | undefined, value: T): T[] {
  const i = entries.findIndex((e) => e.key === key)
  if (i < 0) return insertAt(list, order ?? list.length, value)
  if (order === undefined) return list.map((x, n) => (n === i ? value : x))
  return insertAt(list.filter((_, n) => n !== i), order, value)
}

export function createRulesAdapter(deps: RulesAdapterDeps): ItemAdapter<RulesSettings> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const phases = deps.phases ?? RULES_PHASES

  const adapter: ItemAdapter<RulesSettings> = {
    item: 'rules',

    sharedResourceKey: (zone) => zone.account?.id,
    ownsEntry: (e) => (phases as readonly string[]).includes(e.area) && ownsRuleEntry(e),

    desired(profile, zone) {
      const s = resolveZone(profile.settings, zone.name)
      const out: Entry[] = phases.flatMap((phase) => profileRuleEntries(phase, s.phases[phase] as RawRule[], profile.id))
      for (const r of s.pageRules) {
        const owner = classifyPageRule(r)
        if (owner !== 'rules') throw new UserError(`A Page Rule in this profile belongs to the ${owner} item.`)
      }
      out.push(...pageRuleEntries(s.pageRules).map(plainEntry))
      if (s.bulkRedirects.length > 0) {
        const list = s.bulkRedirectList
        if (list === undefined) throw new UserError('This profile has Bulk Redirects but names no list.')
        for (const b of s.bulkRedirects) {
          if (!hostMatches(b.redirect.source_url, zone.name)) {
            throw new UserError(`The Bulk Redirect source ${b.redirect.source_url} is outside ${zone.name}.`)
          }
          out.push(bulkEntry(list, b))
        }
        out.push(activeEntry(list))
      }
      return out
    },

    read: (client, zone, profile) => readRules(client, zone, profile, false),
    // Import takes every rule
    readForImport: (client, zone, profile) => readRules(client, zone, profile, true),

    async apply(client, zone, desired, changes, unavailable) {
      // Stale only applies before the first write
      const completed: string[] = []
      const step = async (area: string, work: () => Promise<void>): Promise<void> => {
        if (unavailable.includes(area) || !hasChanges(changes, area)) return
        try {
          await work()
          completed.push(area)
        } catch (e) {
          if (completed.length === 0) throw e
          throw new UserError(`${area}: ${describeFailure(e)} Already completed for this zone: ${completed.join(', ')}.`)
        }
      }
      // Shared list first, so its stale check runs before any write
      await step(BULK, () => applyBulk(client, zone, desired, changes, sleep, deps.snapshots))
      for (const phase of phases) await step(phase, () => applyPhase(client, zone, phase, desired, changes))
      await step(PAGE_RULES, () => applyPageRules(client, zone, desired, changes))
    },

    addToProfile: (profile, zone, change) => addRuleToProfile(profile, zone, change)
  }

  async function readRules(client: CfClient, zone: Zone, profile: Profile<RulesSettings>, everything: boolean): Promise<ReadResult> {
      const entries: Entry[] = []
      const unavailable: string[] = []
      const warnings: string[] = []
      const phaseReads = await Promise.all(phases.map((phase) => orUnavailable(() => readEntrypoint(client, `zones/${zone.id}`, phase))))
      const wanted = adapter.desired(profile, zone)
      phaseReads.forEach((r, i) => {
        const phase = phases[i] as RulesPhase
        if (r === 'unavailable') unavailable.push(phase)
        else entries.push(...(everything ? ruleEntries(phase, r.value ?? []).map(plainEntry) : ownedRuleEntries(phase, r.value ?? [], wanted, profile.id)))
      })
      const pages = await orUnavailable(() => readPageRules(client, zone))
      if (pages === 'unavailable') unavailable.push(PAGE_RULES)
      else entries.push(...pageRuleEntries(ownPageRules(pages.value)).map(plainEntry))

      const listName = profile.settings.bulkRedirectList
      if (listName !== undefined) {
        const account = requireAccount(zone)
        const bulk = await orUnavailable(async () => {
          const list = await findList(client, account, listName)
          const items = list ? await readItems(client, account, list.id) : []
          return { items, rules: (await readEntrypoint(client, `accounts/${account}`, REDIRECT_PHASE)) ?? [] }
        })
        if (bulk === 'unavailable') unavailable.push(BULK)
        else {
          const ours = bulk.value.items.filter((i) => hostMatches(i.redirect.source_url, zone.name))
          entries.push(...ours.map((i) => bulkEntry(listName, i)))
          const skipped = bulk.value.items.filter((i) => isSkippedSubdomain(i.redirect.source_url, zone.name)).length
          if (skipped > 0) {
            warnings.push(`Skipped ${plural(skipped, 'Bulk Redirect item')} in "${listName}" for subdomains of ${zone.name}.`)
          }
          const rule = listRule(bulk.value.rules, listName)
          if (profile.settings.bulkRedirects.length > 0 && rule && rule.enabled !== false) entries.push(activeEntry(listName))
        }
      }
      return { entries, unavailable, warnings }
  }

  function addRuleToProfile(profile: Profile<RulesSettings>, zone: Zone, change: Change): Profile<RulesSettings> {
      if (change.type !== 'extra' && change.type !== 'different') return profile
      const { actual } = change
      const value = abstractZone(actual.value, zone.name)
      const entries = adapter.desired(profile, zone).filter((e) => e.area === actual.area)
      const key = 'desired' in change ? change.desired.key : actual.key
      const s = profile.settings
      let settings: RulesSettings
      if (actual.area === PAGE_RULES) {
        settings = { ...s, pageRules: merged(s.pageRules, entries, key, actual.order, value as PageRule) }
      } else if (actual.area === BULK) {
        if (isActiveEntry(actual)) return profile
        const { redirect, comment } = value as BulkRedirect
        const item: BulkRedirect = { redirect, ...(comment === undefined ? {} : { comment }) }
        settings = { ...s, bulkRedirects: merged(s.bulkRedirects, entries, key, undefined, item) }
      } else {
        const phase = actual.area as RulesPhase
        const rule = { ...(value as Rule) }
        // The profile adds its own ref
        if (refOf(rule)?.startsWith(PROFILE_REF)) delete (rule as { ref?: string }).ref
        settings = { ...s, phases: { ...s.phases, [phase]: merged(s.phases[phase], entries, key, actual.order, rule) } }
      }
      return { ...profile, settings }
  }
  return adapter
}
