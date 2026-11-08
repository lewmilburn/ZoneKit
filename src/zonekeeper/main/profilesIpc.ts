import { randomUUID } from 'node:crypto'
import { errorText } from '../shared/errorText'
import { z } from 'zod'
import type { ApplyView, DriftView, ImportSummary, IpcResult, PreviewView, ProfileDto, ProfileItem } from '../shared/ipc'
import type { Profile } from '../shared/model'
import { UserError } from './errors'
import { applyImport, exportProfiles, parseImport, type ImportPreview } from './store/transfer'
import { StoreCorruptError, type FileProfileStore } from './store/profileStore'
import type { SyncPreview } from './sync/adapter'
import type { SyncRunner } from './sync/runner'

export interface ProfilesIpcDeps {
  store: FileProfileStore
  runner: SyncRunner
  now: () => Date
  newId?: () => string
  /** Parent links, exported and imported with profiles. */
  links?: { read(): Promise<Record<string, string>>; merge(links: Record<string, string>): Promise<void> }
  /** Last fully synced version. */
  syncedVersion?: (profileId: string) => number | undefined
  /** Undefined if closed. */
  pickSavePath: (defaultName: string) => Promise<string | undefined>
  pickOpenPath: () => Promise<string | undefined>
  readImportFile: (path: string) => Promise<string>
  writeFile: (path: string, text: string) => Promise<void>
}

const id = z.string().min(1).max(200)
const itemSchema = z.enum(['security', 'sechead', 'secset', 'rules', 'email', 'ssl', 'caching', 'speed', 'network', 'compliance'])
const nameSchema = z.string().trim().min(1).max(500)
const zoneIds = z.array(z.string().min(1).max(100)).max(5000)
const answers = z.array(z.strictObject({ key: z.string().min(1).max(500), hash: z.string().min(1).max(200) })).max(10000)
const updateSchema = z.strictObject({ id, name: nameSchema, zoneIds, settings: z.unknown() })

function emptySettings(item: ProfileItem): unknown {
  if (item === 'security') return { firewall: [] }
  if (item === 'sechead') return { headers: {} }
  if (item === 'ssl' || item === 'caching' || item === 'speed' || item === 'secset' || item === 'network' || item === 'compliance') return {}
  if (item === 'rules') {
    return {
      phases: {
        http_request_firewall_custom: [],
        http_request_dynamic_redirect: [],
        http_request_late_transform: [],
        http_response_headers_transform: []
      },
      pageRules: [],
      bulkRedirects: []
    }
  }
  return { spf: null, dmarc: null, dkim: [] }
}

function describe(e: unknown): string {
  if (e instanceof UserError || e instanceof StoreCorruptError) return e.message
  if (e instanceof Error && (e.message.startsWith('Invalid profile:') || e.message.includes('is already in profile'))) {
    return e.message.slice(0, 500)
  }
  return errorText(e)
}

function describeTransfer(e: unknown): string {
  if (e instanceof Error && e.message.length <= 600) return e.message
  return describe(e)
}

function fail<T>(e: unknown, pick: (e: unknown) => string = describe): IpcResult<T> {
  return { ok: false, error: pick(e), ...(e instanceof Error && e.name === 'ProfileSavedError' ? { profileSaved: true } : {}) }
}

const BAD_INPUT = 'That request was not valid.'
function bad<T>(): IpcResult<T> {
  return { ok: false, error: BAD_INPUT }
}

function dto(p: Profile<unknown>): ProfileDto {
  return {
    id: p.id,
    item: p.item as ProfileItem,
    name: p.name,
    version: p.version,
    zoneIds: [...p.zoneIds],
    settings: p.settings,
    updatedAt: p.updatedAt
  }
}

/** Field by field, so nothing extra reaches the renderer. */
function previewView(p: SyncPreview): PreviewView {
  return {
    id: p.id,
    profileId: p.profileId,
    item: p.item,
    expiresAt: p.expiresAt,
    zones: p.zones.map((z) => ({
      zone: { id: String(z.zone.id), name: String(z.zone.name) },
      changes: z.changes,
      unavailable: z.unavailable,
      warnings: z.warnings,
      ...(z.failure === undefined ? {} : { failure: z.failure })
    })),
    conflicts: p.conflicts.map((c) => ({ key: c.key, hash: c.hash })),
    canApply: p.canApply
  }
}

/** Arguments are untrusted. */
export function createProfilesHandlers(deps: ProfilesIpcDeps) {
  const newId = deps.newId ?? randomUUID
  const imports = new Map<string, ImportPreview>()

  return {
    async profilesList(raw: unknown): Promise<IpcResult<ProfileDto[]>> {
      const item = itemSchema.safeParse(raw)
      if (!item.success) return bad()
      try {
        return { ok: true, value: (await deps.store.list(item.data)).map(dto) }
      } catch (e) {
        return fail(e)
      }
    },

    async syncPending(): Promise<IpcResult<ProfileDto[]>> {
      try {
        const lists = await Promise.all(itemSchema.options.map((item) => deps.store.list(item)))
        return { ok: true, value: lists.flat().filter((p) => p.zoneIds.length > 0 && deps.syncedVersion?.(p.id) !== p.version).map(dto) }
      } catch (e) {
        return fail(e)
      }
    },

    async profileCreate(rawItem: unknown, rawName: unknown): Promise<IpcResult<ProfileDto>> {
      const item = itemSchema.safeParse(rawItem)
      const name = nameSchema.safeParse(rawName)
      if (!item.success || !name.success) return bad()
      try {
        const saved = await deps.store.save({
          id: newId(),
          item: item.data,
          name: name.data,
          version: 1,
          zoneIds: [],
          settings: emptySettings(item.data),
          updatedAt: deps.now().toISOString()
        })
        return { ok: true, value: dto(saved) }
      } catch (e) {
        return fail(e)
      }
    },

    async profileUpdate(raw: unknown): Promise<IpcResult<ProfileDto>> {
      const input = updateSchema.safeParse(raw)
      if (!input.success) return bad()
      try {
        const existing = await deps.store.get(input.data.id)
        if (!existing) return { ok: false, error: 'That profile no longer exists.' }
        const saved = await deps.store.save({
          ...existing,
          name: input.data.name,
          zoneIds: input.data.zoneIds,
          settings: input.data.settings,
          updatedAt: deps.now().toISOString()
        })
        return { ok: true, value: dto(saved) }
      } catch (e) {
        return fail(e)
      }
    },

    async profileDelete(raw: unknown): Promise<IpcResult> {
      const pid = id.safeParse(raw)
      if (!pid.success) return bad()
      try {
        await deps.store.delete(pid.data)
        return { ok: true, value: undefined }
      } catch (e) {
        return fail(e)
      }
    },

    async syncPreview(raw: unknown): Promise<IpcResult<PreviewView>> {
      const pid = id.safeParse(raw)
      if (!pid.success) return bad()
      try {
        return { ok: true, value: previewView(await deps.runner.preview(pid.data)) }
      } catch (e) {
        return fail(e)
      }
    },

    /** Read-only. */
    async profileDrift(raw: unknown): Promise<IpcResult<DriftView>> {
      const pid = id.safeParse(raw)
      if (!pid.success) return bad()
      try {
        const p = await deps.runner.preview(pid.data)
        const name = (key: string): string => key.replace(/^setting:/, '').replace(/_/g, ' ')
        try {
          const zones = p.zones.map((z) => ({
            zoneId: String(z.zone.id),
            zoneName: String(z.zone.name),
            differences: z.changes.flatMap((c) =>
              c.type === 'add' ? [`missing ${name(c.entry.key)}`] : c.type === 'different' ? [`${name(c.desired.key)} differs`] : c.type === 'extra' ? [`${name(c.actual.key)} isn't in the profile`] : []
            ),
            ...(z.failure === undefined ? {} : { failure: z.failure }),
            unavailable: z.unavailable
          }))
          return { ok: true, value: { profileId: pid.data, inSync: zones.every((z) => z.differences.length === 0 && !z.failure), zones } }
        } finally {
          await deps.runner.cancel(p.id).catch(() => undefined)
        }
      } catch (e) {
        return fail(e)
      }
    },

    async syncAddToProfile(rawPreview: unknown, rawKey: unknown, rawZone: unknown): Promise<IpcResult<PreviewView>> {
      const p = id.safeParse(rawPreview)
      const key = z.string().min(1).max(500).safeParse(rawKey)
      const zone = z.string().min(1).max(100).safeParse(rawZone)
      if (!p.success || !key.success || !zone.success) return bad()
      try {
        return { ok: true, value: previewView(await deps.runner.addToProfileAndResync(p.data, key.data, zone.data)) }
      } catch (e) {
        return fail(e)
      }
    },

    async syncAddAllToProfile(raw: unknown): Promise<IpcResult<PreviewView>> {
      const p = id.safeParse(raw)
      if (!p.success) return bad()
      try {
        return { ok: true, value: previewView(await deps.runner.addAllToProfileAndResync(p.data)) }
      } catch (e) {
        return fail(e)
      }
    },

    async syncCancel(raw: unknown): Promise<IpcResult<{ cancelled: boolean; profileSaved: boolean }>> {
      const p = id.safeParse(raw)
      if (!p.success) return bad()
      try {
        return { ok: true, value: await deps.runner.cancel(p.data) }
      } catch (e) {
        return fail(e)
      }
    },

    async syncApply(rawPreview: unknown, rawAnswers: unknown): Promise<IpcResult<ApplyView>> {
      const p = id.safeParse(rawPreview)
      const a = answers.safeParse(rawAnswers)
      if (!p.success || !a.success) return bad()
      try {
        const out = await deps.runner.apply(p.data, a.data)
        return {
          ok: true,
          value: {
            results: out.results.map((r) => ({
              zoneId: r.zoneId,
              zoneName: r.zoneName,
              status: r.status,
              ...(r.reason === undefined ? {} : { reason: r.reason }),
              writeAttempted: r.writeAttempted,
              unavailable: r.unavailable
            }))
          }
        }
      } catch (e) {
        return fail(e)
      }
    },

    async exportProfiles(raw: unknown): Promise<IpcResult<boolean>> {
      const ids = z.array(id).min(1).max(5000).safeParse(raw)
      if (!ids.success) return bad()
      try {
        const text = await exportProfiles(deps.store, ids.data, (await deps.links?.read()) ?? {})
        const path = await deps.pickSavePath('zonekeeper-profiles.json')
        if (!path) return { ok: true, value: false }
        await deps.writeFile(path, text)
        return { ok: true, value: true }
      } catch (e) {
        return e instanceof Error && e.message.startsWith('Cannot export') ? fail(e, describeTransfer) : { ok: false, error: 'The file could not be written.' }
      }
    },

    async importPick(): Promise<IpcResult<ImportSummary | null>> {
      let text: string
      try {
        const path = await deps.pickOpenPath()
        if (!path) return { ok: true, value: null }
        text = await deps.readImportFile(path)
      } catch (e) {
        return { ok: false, error: e instanceof UserError ? e.message : 'The file could not be read.' }
      }
      try {
        const preview = await parseImport(deps.store, text)
        const importId = newId()
        imports.clear()
        imports.set(importId, preview)
        const brief = (p: Profile<unknown>): { id: string; name: string; item: string } => ({ id: p.id, name: p.name, item: p.item })
        return {
          ok: true,
          value: {
            importId,
            added: preview.added.map(brief),
            replaced: preview.replaced.map((r) => brief(r.incoming)),
            zoneClashes: preview.zoneClashes
          }
        }
      } catch (e) {
        return fail(e, describeTransfer)
      }
    },

    async importApply(rawId: unknown, rawReplace: unknown): Promise<IpcResult> {
      const iid = id.safeParse(rawId)
      const replace = z.array(id).max(5000).safeParse(rawReplace)
      const preview = iid.success ? imports.get(iid.data) : undefined
      if (!iid.success || !replace.success || !preview) return { ok: false, error: 'This import expired, choose the file again.' }
      try {
        await applyImport(deps.store, preview, replace.data)
        if (Object.keys(preview.parentLinks).length > 0) await deps.links?.merge(preview.parentLinks)
        imports.delete(iid.data)
        return { ok: true, value: undefined }
      } catch (e) {
        return fail(e, describeTransfer)
      }
    }
  }
}
