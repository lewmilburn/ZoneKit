import { createHash, randomUUID } from 'node:crypto'
import { diffEntries, isConflict, stripServerFields } from '../../shared/diff'
import type { LastSynced } from './lastSynced'
import type { Change, Entry, ItemKind, Profile } from '../../shared/model'
import { findZoneLiterals } from '../../shared/placeholder'
import { CfApiError, type CfClient, type Zone } from '../cloudflare/client'
import { StaleZoneError, UserError, ZoneNotWrittenError } from '../errors'
import type { ProfileStore } from '../store/profileStore'
import type {
  ApplyOutcome,
  CancelOutcome,
  ItemAdapter,
  OverwriteAnswer,
  ReadResult,
  SyncPreview,
  ZonePreview,
  ZoneResult
} from './adapter'
import { errorText } from '../../shared/errorText'

/** What a zone held just before its write. */
interface ZonePriorState {
  zoneId: string
  entries: Entry[]
  unavailable: string[]
}

const ZONE_CONCURRENCY = 8
const PREVIEW_TTL_MS = 30 * 60 * 1000

export interface SyncProgress {
  phase: 'preview' | 'apply'
  profileId: string
  zoneId: string
  status?: ZoneResult['status']
  /** Zones finished so far, of `total`. */
  done: number
  total: number
}

export interface RunnerDeps {
  store: ProfileStore
  client: CfClient
  adapters: Partial<Record<ItemKind, ItemAdapter<unknown>>>
  now: () => Date
  onProgress?: (p: SyncProgress) => void
  newId?: () => string
  /** Every zone ended in sync. */
  onSynced?: (profileId: string, version: number) => void
  lastSynced?: LastSynced
  /** Child zone id to parent zone id, children get their parent's profiles. */
  parentLinks?: () => Promise<Record<string, string>>
}

/** Profile saved, but no new preview. */
export class ProfileSavedError extends UserError {
  constructor(reason: string) {
    super(`The profile was saved, but the new preview could not be built: ${reason} Start a new preview to continue.`)
    this.name = 'ProfileSavedError'
  }
}

interface OpenZone {
  view: ZonePreview
  desired: Entry[]
  seen: Entry[]
  /** Not carried over to the next read. */
  readWarnings: string[]
}

interface OpenPreview {
  view: SyncPreview
  zones: OpenZone[]
  adapter: ItemAdapter<unknown>
  profile: Profile<unknown>
  addedToProfile: { zoneId: string; entryKey: string }[]
}

interface ZoneOutcome {
  result: ZoneResult
  prior: ZonePriorState
}

/** Kept when no preview is open. */
interface Carried {
  warnings: Map<string, string[]>
  added: OpenPreview['addedToProfile']
}

function carriedFrom(open: OpenPreview): Carried {
  return {
    warnings: new Map(open.zones.map((z) => [z.view.zone.id, z.view.warnings.filter((w) => !z.readWarnings.includes(w))])),
    added: open.addedToProfile
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (typeof v !== 'object' || v === null) return v
  const o = v as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, sortKeys(o[k])])
  )
}

/** What an Overwrite answer authorises. */
function changeHash(c: Change): string {
  const side = (x?: Entry): unknown =>
    x && [x.key, x.area, x.order ?? null, sortKeys(stripServerFields(x.value))]
  const desired = c.type === 'different' ? c.desired : undefined
  const actual = c.type === 'different' || c.type === 'extra' ? c.actual : undefined
  return createHash('sha256')
    .update(JSON.stringify([c.type, side(desired) ?? null, side(actual) ?? null]))
    .digest('hex')
}

function zoneOutcome(
  zone: OpenZone,
  status: ZoneResult['status'],
  prior: ZonePriorState,
  writeAttempted: boolean,
  reason?: string
): ZoneOutcome {
  const { id, name } = zone.view.zone
  return {
    result: {
      zoneId: id,
      zoneName: name,
      status,
      writeAttempted,
      unavailable: prior.unavailable,
      ...(reason ? { reason } : {})
    },
    prior
  }
}

function markOwned(adapter: ItemAdapter<unknown>, changes: Change[]): Change[] {
  return changes.map((c) => (c.type === 'extra' && adapter.ownsEntry?.(c.actual) ? { ...c, owned: true as const } : c))
}

function assertZonesAgree(zones: OpenZone[]): void {
  const seen = new Map<string, { zone: string; actual: Entry }>()
  for (const zone of zones) {
    for (const change of zone.view.changes.filter(isConflict)) {
      if (change.type !== 'extra' && change.type !== 'different') continue
      const other = seen.get(change.actual.key)
      const same = other && diffEntries([{ ...other.actual, order: undefined }], [{ ...change.actual, order: undefined }]).every((c) => c.type === 'unchanged')
      if (other && !same) {
        throw new UserError(`${other.zone} and ${zone.view.zone.name} have different values for ${change.actual.key}, use Overwrite profile on the one to keep.`)
      }
      seen.set(change.actual.key, { zone: zone.view.zone.name, actual: change.actual })
    }
  }
}

/** A zone still holding what the profile last wrote only changed in the profile, so it isn't a conflict. */
function markExpected(changes: Change[], last: Entry[] | null): Change[] {
  if (!last) return changes
  const before = new Map(last.map((e) => [e.key, e]))
  const wrote = (actual: Entry): boolean => {
    const prev = before.get(actual.key)
    return prev !== undefined && diffEntries([{ ...prev, order: undefined }], [{ ...actual, order: undefined }]).every((c) => c.type === 'unchanged')
  }
  return changes.map((c) => {
    if (c.type === 'different' && wrote(c.actual)) return { ...c, expected: true as const }
    if (c.type === 'extra' && !c.owned && wrote(c.actual)) return { ...c, owned: true as const }
    return c
  })
}

/** Only safe text reaches results and history. */
function reasonFor(e: unknown): string {
  if (e instanceof CfApiError) {
    if (e.status === 401) return 'Your Cloudflare token is no longer valid, sign in again.'
    if (e.status === 403) {
      return `Cloudflare refused access, ${e.message}`
    }
    return e.message
  }
  if (e instanceof UserError) return e.message
  // Unexpected errors are shown as they are, minus anything that looks like a token
  return errorText(e).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b[A-Za-z0-9_-]{40}\b/g, '[redacted]')
}

/** Unavailable areas are unknown, so never compared. */
function visible(read: ReadResult): { entries: Entry[]; unavailable: string[] } {
  const unavailable = [...new Set(read.unavailable)]
  return { entries: withoutAreas(read.entries, unavailable), unavailable }
}

function withoutAreas(entries: Entry[], areas: string[]): Entry[] {
  return entries.filter((x) => !areas.includes(x.area))
}

function sameAreas(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x))
}

function entryKeyOf(c: Change): string {
  if (c.type === 'extra') return c.actual.key
  if (c.type === 'different') return c.desired.key
  return c.entry.key
}

async function inPool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(ZONE_CONCURRENCY, items.length) }, worker))
  return out
}

export class SyncRunner {
  private readonly open = new Map<string, OpenPreview>()
  private readonly locks = new Set<string>()
  private readonly applying = new Set<string>()
  /** By old preview ID. Never reject. */
  private readonly adding = new Map<string, Promise<{ newId?: string; saved: boolean }>>()
  private readonly carried = new Map<string, Carried>()
  private readonly sharedTails = new Map<string, Promise<unknown>>()
  private readonly newId: () => string

  constructor(private readonly deps: RunnerDeps) {
    this.newId = deps.newId ?? randomUUID
  }

  async preview(profileId: string): Promise<SyncPreview> {
    if (this.locks.has(profileId)) {
      // Only idle previews expire
      const abandoned = [...this.open.values()].find((o) => o.view.profileId === profileId && this.isExpired(o))
      if (!abandoned) throw new UserError('A sync is already running for this profile.')
      this.expire(abandoned)
    }
    this.locks.add(profileId)
    try {
      const carried = this.carried.get(profileId)
      const view = await this.build(profileId, carried?.warnings ?? new Map(), carried?.added ?? [])
      this.carried.delete(profileId)
      return view
    } catch (e) {
      this.locks.delete(profileId)
      throw e
    }
  }

  /** Returns a new preview. */
  async addToProfileAndResync(previewId: string, conflictKey: string, zoneId: string): Promise<SyncPreview> {
    const old = this.take(previewId)
    const state = { saved: old.addedToProfile.length > 0 }
    const work = this.runAdd(old, conflictKey, zoneId, state)
    const settled = work
      .then(
        (view) => ({ newId: view.id, saved: state.saved }),
        () => ({ saved: state.saved })
      )
      .finally(() => this.adding.delete(previewId))
    this.adding.set(previewId, settled)
    return work
  }

  /** Stops, keeping the preview, if zones disagree. */
  async addAllToProfileAndResync(previewId: string): Promise<SyncPreview> {
    const peek = this.open.get(previewId)
    if (peek) assertZonesAgree(peek.zones)
    const old = this.take(previewId)
    const profileId = old.view.profileId
    const state = { saved: old.addedToProfile.length > 0 }
    const work = (async (): Promise<SyncPreview> => {
      try {
        let updated = await this.currentProfile(old)
        const carried = carriedFrom(old)
        const added = [...old.addedToProfile]
        for (const zone of [...old.zones].reverse()) {
          for (const change of zone.view.changes.filter(isConflict)) {
            updated = old.adapter.addToProfile(updated, zone.view.zone, change)
            added.push({ zoneId: zone.view.zone.id, entryKey: entryKeyOf(change) })
            const actual = change.type === 'extra' || change.type === 'different' ? change.actual : undefined
            const zoneId = zone.view.zone.id
            carried.warnings.set(zoneId, [...new Set([...(carried.warnings.get(zoneId) ?? []), ...findZoneLiterals(actual?.value, zone.view.zone.name)])])
          }
        }
        await this.deps.store.save({ ...updated, updatedAt: this.deps.now().toISOString() })
        state.saved = true
        carried.added = added
        try {
          return await this.build(profileId, carried.warnings, carried.added)
        } catch (e) {
          this.carried.set(profileId, carried)
          throw new ProfileSavedError(reasonFor(e))
        }
      } catch (e) {
        this.locks.delete(profileId)
        throw e
      }
    })()
    const settled = work
      .then(
        (view) => ({ newId: view.id, saved: state.saved }),
        () => ({ saved: state.saved })
      )
      .finally(() => this.adding.delete(previewId))
    this.adding.set(previewId, settled)
    return work
  }

  private async runAdd(
    old: OpenPreview,
    conflictKey: string,
    zoneId: string,
    state: { saved: boolean }
  ): Promise<SyncPreview> {
    const profileId = old.view.profileId
    try {
      const profile = await this.currentProfile(old)
      const zone = old.zones.find((z) => z.view.zone.id === zoneId)
      const matches = (zone?.view.changes ?? []).filter(
        (c) => isConflict(c) && (entryKeyOf(c) === conflictKey || `${zoneId}:${entryKeyOf(c)}` === conflictKey)
      )
      if (!zone || matches.length !== 1) {
        throw new UserError(`"${conflictKey}" is not a conflict in zone ${zoneId}.`)
      }
      const change = matches[0]
      const updated = old.adapter.addToProfile(profile, zone.view.zone, change)
      if (updated.id !== profile.id || updated.item !== profile.item) {
        throw new Error('Adapter returned a different profile.')
      }
      const actual = change.type === 'extra' || change.type === 'different' ? change.actual : undefined
      const literals = findZoneLiterals(actual?.value, zone.view.zone.name)
      await this.deps.store.save({ ...updated, updatedAt: this.deps.now().toISOString() })
      state.saved = true
      const carried = carriedFrom(old)
      const earlier = carried.warnings.get(zoneId) ?? []
      carried.warnings.set(zoneId, [...new Set([...earlier, ...literals])])
      carried.added = [...old.addedToProfile, { zoneId, entryKey: entryKeyOf(change) }]
      try {
        return await this.build(profileId, carried.warnings, carried.added)
      } catch (e) {
        this.carried.set(profileId, carried)
        throw new ProfileSavedError(reasonFor(e))
      }
    } catch (e) {
      this.locks.delete(profileId)
      throw e
    }
  }

  /** Rejects once apply has started. */
  async cancel(previewId: string): Promise<CancelOutcome> {
    if (this.applying.has(previewId)) {
      throw new UserError('This sync is in progress and can no longer be cancelled.')
    }
    const inFlight = this.adding.get(previewId)
    if (inFlight) {
      const { newId, saved } = await inFlight
      const next = newId === undefined ? undefined : this.open.get(newId)
      if (next) this.close(next)
      return { cancelled: true, profileSaved: saved }
    }
    const open = this.open.get(previewId)
    if (!open) return { cancelled: false, profileSaved: false }
    this.close(open)
    return { cancelled: true, profileSaved: open.addedToProfile.length > 0 }
  }

  /** Single use, a rejection means nothing was written. */
  async apply(previewId: string, overwrites: OverwriteAnswer[]): Promise<ApplyOutcome> {
    const open = this.take(previewId)
    this.applying.add(previewId)
    try {
      const failed = open.zones.filter((z) => z.view.failure !== undefined)
      if (failed.length > 0) {
        const names = failed.map((z) => z.view.zone.name).join(', ')
        throw new UserError(`These zones couldn't be read: ${names}.`)
      }
      this.assertAnswered(open, overwrites)
      await this.currentProfile(open)

      let done = 0
      const total = open.zones.length
      this.emit({ phase: 'apply', profileId: open.view.profileId, zoneId: '', done, total })
      const outcomes = await inPool(open.zones, async (zone) => {
        const outcome = await this.applyZoneInTurn(open, zone)
        this.emit({
          phase: 'apply',
          profileId: open.view.profileId,
          zoneId: zone.view.zone.id,
          status: outcome.result.status,
          done: ++done,
          total
        })
        return outcome
      })

      const results = outcomes.map((o) => o.result)
      if (results.every((r) => (r.status === 'applied' || r.status === 'unchanged') && r.unavailable.length === 0)) {
        this.deps.onSynced?.(open.view.profileId, open.view.profileVersion)
      }
      return { results }
    } finally {
      this.applying.delete(previewId)
      this.locks.delete(open.view.profileId)
    }
  }

  /** Synchronous, so a preview can't be taken twice. */
  private take(previewId: string): OpenPreview {
    const open = this.open.get(previewId)
    if (!open) throw new UserError('This preview is no longer valid, start a new one.')
    if (this.isExpired(open)) {
      this.expire(open)
      throw new UserError('This preview has expired, start a new one.')
    }
    this.open.delete(previewId)
    return open
  }

  private isExpired(open: OpenPreview): boolean {
    return this.deps.now().getTime() >= Date.parse(open.view.expiresAt)
  }

  private close(open: OpenPreview): void {
    this.open.delete(open.view.id)
    this.locks.delete(open.view.profileId)
  }

  private expire(open: OpenPreview): void {
    this.close(open)
    if (open.addedToProfile.length > 0) this.carried.set(open.view.profileId, carriedFrom(open))
  }

  /** One zone per key at a time, never rejects. */
  private async applyZoneInTurn(open: OpenPreview, zone: OpenZone): Promise<ZoneOutcome> {
    let key: string | undefined
    try {
      key = open.adapter.sharedResourceKey?.(zone.view.zone)
    } catch (e) {
      const prior = { zoneId: zone.view.zone.id, entries: zone.seen, unavailable: zone.view.unavailable }
      return zoneOutcome(zone, 'failed', prior, false, `${reasonFor(e)} Nothing was written to this zone.`)
    }
    if (key === undefined) return this.applyZone(open, zone)
    const sharedKey = key
    const run = (this.sharedTails.get(sharedKey) ?? Promise.resolve()).then(() => this.applyZone(open, zone))
    this.sharedTails.set(sharedKey, run)
    const outcome = await run
    if (this.sharedTails.get(sharedKey) === run) this.sharedTails.delete(sharedKey)
    return outcome
  }

  private assertAnswered(open: OpenPreview, overwrites: OverwriteAnswer[]): void {
    const required = new Map(open.view.conflicts.map((c) => [c.key, c.hash]))
    const unknown = overwrites.filter((a) => !required.has(a.key)).map((a) => a.key)
    if (unknown.length > 0) {
      throw new UserError(`Unknown conflict keys: ${unknown.join(', ')}.`)
    }
    const changed = overwrites.filter((a) => required.get(a.key) !== a.hash).map((a) => a.key)
    if (changed.length > 0) {
      throw new UserError(`These conflicts changed and need a new answer: ${changed.join(', ')}.`)
    }
    const given = new Set(overwrites.map((a) => a.key))
    const missing = [...required.keys()].filter((k) => !given.has(k))
    if (missing.length > 0) {
      throw new UserError(`These conflicts have no answer: ${missing.join(', ')}.`)
    }
  }

  private async currentProfile(open: OpenPreview): Promise<Profile<unknown>> {
    const profile = await this.deps.store.get(open.view.profileId)
    if (!profile || profile.version !== open.view.profileVersion) {
      throw new UserError('The profile changed, start a new preview.')
    }
    return profile
  }

  private async build(
    profileId: string,
    warnings: Map<string, string[]>,
    addedToProfile: OpenPreview['addedToProfile']
  ): Promise<SyncPreview> {
    const profile = await this.deps.store.get(profileId)
    if (!profile) throw new UserError(`There is no profile with ID "${profileId}".`)
    const adapter = this.deps.adapters[profile.item]
    if (!adapter) throw new UserError(`Syncing "${profile.item}" profiles is not available yet.`)
    const known = new Map((await this.deps.client.listZones()).map((z) => [z.id, z]))
    const links: Record<string, string> = (await this.deps.parentLinks?.().catch(() => ({}))) ?? {}
    const children = Object.entries(links).filter(([child, parent]) => profile.zoneIds.includes(parent) && !profile.zoneIds.includes(child)).map(([child]) => child)
    const zoneIds = [...profile.zoneIds, ...children.filter((c) => known.has(c))]

    let done = 0
    this.emit({ phase: 'preview', profileId, zoneId: '', done, total: zoneIds.length })
    const zones = await inPool(zoneIds, async (zoneId) => {
      const zone = await this.previewZone(profile, adapter, known.get(zoneId) ?? { id: zoneId, name: zoneId }, known.has(zoneId))
      zone.view.warnings = [...new Set([...(warnings.get(zoneId) ?? []), ...zone.readWarnings])]
      this.emit({ phase: 'preview', profileId, zoneId, done: ++done, total: zoneIds.length })
      return zone
    })

    const id = this.newId()
    const created = this.deps.now()
    const conflicts = zones.flatMap((z) =>
      z.view.changes.filter(isConflict).map((c) => ({ key: `${z.view.zone.id}:${entryKeyOf(c)}`, hash: changeHash(c) }))
    )
    const view: SyncPreview = {
      id,
      profileId,
      profileVersion: profile.version,
      item: profile.item,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + PREVIEW_TTL_MS).toISOString(),
      zones: zones.map((z) => z.view),
      conflictKeys: conflicts.map((c) => c.key),
      conflicts,
      canApply: zones.every((z) => z.view.failure === undefined)
    }
    this.open.set(id, { view, zones, adapter, profile, addedToProfile })
    // A copy, so callers can't alter what apply checks
    return structuredClone(view)
  }

  /** The zone's profiles for this item, in name order. */
  private async profilesFor(profile: Profile<unknown>, zone: Zone): Promise<Profile<unknown>[]> {
    const others = (await this.deps.store.list(profile.item)).filter((p) => p.id !== profile.id && p.zoneIds.includes(zone.id))
    return [...others, profile].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  /** Clashing profiles stop the sync. */
  private async combinedDesired(profile: Profile<unknown>, adapter: ItemAdapter<unknown>, zone: Zone): Promise<Entry[]> {
    const chosen = new Map<string, { entry: Entry; from: string }>()
    const next = new Map<string, number>()
    const out: Entry[] = []
    const profiles = await this.profilesFor(profile, zone)
    if (profiles.length === 1) return adapter.desired(profile, zone)
    for (const p of profiles) {
      for (const entry of adapter.desired(p, zone)) {
        const seen = chosen.get(entry.key)
        if (seen) {
          const same = diffEntries([{ ...seen.entry, order: undefined }], [{ ...entry, order: undefined }]).every((c) => c.type === 'unchanged')
          if (!same) {
            throw new UserError(`The profiles "${seen.from}" and "${p.name}" both set ${entry.key} to different values on this zone.`)
          }
          continue
        }
        chosen.set(entry.key, { entry, from: p.name })
        // Profiles run in name order
        const order = next.get(entry.area) ?? 0
        next.set(entry.area, order + 1)
        out.push(entry.order === undefined ? entry : { ...entry, order })
      }
    }
    return out
  }

  private async readCombined(profile: Profile<unknown>, adapter: ItemAdapter<unknown>, zone: Zone): Promise<ReadResult> {
    const entries = new Map<string, Entry>()
    const unavailable = new Set<string>()
    const warnings = new Set<string>()
    const profiles = await this.profilesFor(profile, zone)
    for (const r of await Promise.all(profiles.map((p) => adapter.read(this.deps.client, zone, p)))) {
      for (const e of r.entries) if (!entries.has(e.key)) entries.set(e.key, e)
      for (const a of r.unavailable) unavailable.add(a)
      for (const w of r.warnings ?? []) warnings.add(w)
    }
    return { entries: [...entries.values()], unavailable: [...unavailable], warnings: [...warnings] }
  }

  private async previewZone(
    profile: Profile<unknown>,
    adapter: ItemAdapter<unknown>,
    zone: Zone,
    accessible: boolean
  ): Promise<OpenZone> {
    const failed = (failure: string): OpenZone => ({
      view: { zone, changes: [], unavailable: [], warnings: [], failure },
      desired: [],
      seen: [],
      readWarnings: []
    })
    if (!accessible) return failed('This zone is not accessible with your current sign-in.')
    try {
      const result = await this.readCombined(profile, adapter, zone)
      const { entries, unavailable } = visible(result)
      const desired = withoutAreas(await this.combinedDesired(profile, adapter, zone), unavailable)
      const last = (await this.deps.lastSynced?.get(profile.id, zone.id).catch(() => null)) ?? null
      const changes = markExpected(markOwned(adapter, diffEntries(desired, entries)), last)
      return { view: { zone, changes, unavailable, warnings: [] }, desired, seen: entries, readWarnings: result.warnings ?? [] }
    } catch (e) {
      return failed(reasonFor(e))
    }
  }

  /** Never rejects. */
  private async applyZone(open: OpenPreview, zone: OpenZone): Promise<ZoneOutcome> {
    const { zone: target, unavailable } = zone.view
    const finish = (
      status: ZoneResult['status'],
      state: ZonePriorState,
      writeAttempted: boolean,
      reason?: string
    ): ZoneOutcome => zoneOutcome(zone, status, state, writeAttempted, reason)
    let prior: ZonePriorState = { zoneId: target.id, entries: zone.seen, unavailable }
    try {
      const fresh = visible(await this.readCombined(open.profile, open.adapter, target))
      prior = { zoneId: target.id, entries: fresh.entries, unavailable: fresh.unavailable }
      const wanted = withoutAreas(await this.combinedDesired(open.profile, open.adapter, target), fresh.unavailable)
      if (!diffEntries(zone.desired, wanted).every((c) => c.type === 'unchanged')) {
        return finish('stale', prior, false, 'Another profile on this zone changed, start a new preview.')
      }
      const same =
        sameAreas(fresh.unavailable, unavailable) &&
        diffEntries(zone.seen, fresh.entries).every((c) => c.type === 'unchanged')
      if (!same) {
        return finish('stale', prior, false, 'This zone changed, start a new preview.')
      }
      // From the re-read, so ids are current
      const last = (await this.deps.lastSynced?.get(open.profile.id, target.id).catch(() => null)) ?? null
      const changes = markExpected(markOwned(open.adapter, diffEntries(zone.desired, fresh.entries)), last)
      const remember = (): Promise<void> => this.deps.lastSynced?.set(open.profile.id, target.id, zone.desired).catch(() => undefined) ?? Promise.resolve()
      if (changes.every((c) => c.type === 'unchanged')) {
        await remember()
        return finish('unchanged', prior, false)
      }
      const profile = await this.deps.store.get(open.view.profileId)
      if (profile?.version !== open.view.profileVersion) {
        return finish('stale', prior, false, 'The profile changed during this sync, start a new preview.')
      }
      try {
        await open.adapter.apply(this.deps.client, target, zone.desired, changes, fresh.unavailable)
      } catch (e) {
        if (e instanceof StaleZoneError) return finish('stale', prior, false, e.message)
        if (e instanceof ZoneNotWrittenError) return finish('failed', prior, false, e.message)
        return finish('failed', prior, true, `${reasonFor(e)} This zone may be partly changed.`)
      }
      await remember()
      return finish('applied', prior, true)
    } catch (e) {
      return finish('failed', prior, false, `${reasonFor(e)} Nothing was written to this zone.`)
    }
  }

  private emit(p: SyncProgress): void {
    try {
      this.deps.onProgress?.(p)
    } catch {
      // Never interrupt live writes
    }
  }
}
