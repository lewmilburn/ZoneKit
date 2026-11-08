import type { ItemKind, Profile } from '../../shared/model'
import {
  FORMAT_VERSION,
  MAX_IMPORT_BYTES,
  describeIssues,
  findForbiddenKey,
  importEnvelopeSchema,
  parseProfile
} from '../../shared/schemas'
import { ITEM_KINDS } from '../../shared/schemas'
import { FileProfileStore, type ProfileStore } from './profileStore'

export interface ImportPreview {
  added: Profile<unknown>[]
  replaced: { existing: Profile<unknown>; incoming: Profile<unknown> }[]
  zoneClashes: { zoneId: string; item: ItemKind; profileId: string }[]
  parentLinks: Record<string, string>
}

export type TransferStore = ProfileStore & Pick<FileProfileStore, 'saveAll'>

async function all(store: ProfileStore): Promise<Profile<unknown>[]> {
  return (await Promise.all(ITEM_KINDS.map((k) => store.list(k)))).flat()
}

/** Allowlisted fields only, plus parent links. */
export async function exportProfiles(store: ProfileStore, ids: string[], parentLinks: Record<string, string> = {}): Promise<string> {
  const profiles: Profile<unknown>[] = []
  for (const id of ids) {
    const p = await store.get(id)
    if (!p) throw new Error(`Cannot export: no profile with ID "${id}"`)
    profiles.push({
      id: p.id,
      item: p.item,
      name: p.name,
      version: p.version,
      zoneIds: [...p.zoneIds],
      settings: p.settings,
      updatedAt: p.updatedAt
    })
  }
  return JSON.stringify({ formatVersion: FORMAT_VERSION, profiles, ...(Object.keys(parentLinks).length > 0 ? { parentLinks } : {}) }, null, 2)
}

export async function parseImport(store: ProfileStore, text: string): Promise<ImportPreview> {
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
    throw new Error('Import file is over the 10 MB limit.')
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('Import file is not valid JSON. Nothing was changed.')
  }
  const forbidden = findForbiddenKey(json)
  if (forbidden) throw new Error(`Import file contains a forbidden key (${forbidden}).`)

  const version = (json as { formatVersion?: unknown } | null)?.formatVersion
  if (typeof version === 'number' && version > FORMAT_VERSION) {
    throw new Error(
      `Import file is from a newer version, update ZoneKeeper to import it.`
    )
  }
  const env = importEnvelopeSchema.safeParse(json)
  if (!env.success) throw new Error(`Import file is invalid: ${describeIssues(env.error)}.`)

  const incoming: Profile<unknown>[] = env.data.profiles.map((raw, i) => {
    try {
      return parseProfile(raw)
    } catch (e) {
      throw new Error(`Import file is invalid at profile ${i + 1}: ${(e as Error).message}`)
    }
  })
  const ids = new Set<string>()
  for (const p of incoming) {
    if (ids.has(p.id)) throw new Error(`Import file has duplicate profile ID "${p.id}". Nothing was changed.`)
    ids.add(p.id)
  }

  const existing = await all(store)
  const byId = new Map(existing.map((p) => [p.id, p]))
  const preview: ImportPreview = { added: [], replaced: [], zoneClashes: [], parentLinks: env.data.parentLinks ?? {} }
  for (const p of incoming) {
    const e = byId.get(p.id)
    if (e && e.item !== p.item) {
      throw new Error(
        `Profile "${p.id}" is a different type in the import file.`
      )
    }
    if (e) preview.replaced.push({ existing: e, incoming: p })
    else preview.added.push(p)
  }

  return preview
}

/** All or nothing, throws if the store changed since the preview. */
export async function applyImport(store: TransferStore, preview: ImportPreview, replaceIds: string[]): Promise<void> {
  const wanted = new Set(replaceIds)
  const toSave: Profile<unknown>[] = []
  const expectNew = new Set<string>()
  const expectVersion = new Map<string, number>()

  for (const raw of preview.added) {
    const p = parseProfile(raw)
    expectNew.add(p.id)
    toSave.push(p)
  }
  for (const r of preview.replaced) {
    const p = parseProfile(r.incoming)
    if (!wanted.has(p.id)) continue
    expectVersion.set(p.id, parseProfile(r.existing).version)
    toSave.push(p)
  }
  if (toSave.length === 0) return
  await store.saveAll(toSave, (current) => {
    const byId = new Map(current.map((c) => [c.id, c]))
    for (const id of expectNew) {
      if (byId.has(id)) throw new Error(`Profile "${id}" now exists, choose the file again.`)
    }
    for (const [id, version] of expectVersion) {
      const c = byId.get(id)
      if (!c || c.version !== version) {
        throw new Error(`Profile "${id}" changed, choose the file again.`)
      }
    }
  })
}
