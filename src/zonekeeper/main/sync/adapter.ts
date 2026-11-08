import type { Change, Entry, ItemKind, Profile } from '../../shared/model'
import type { CfClient, Zone } from '../cloudflare/client'

export interface ReadResult {
  entries: Entry[]
  /** Areas the token or plan can't read, unknown rather than empty. */
  unavailable: string[]
  /** No secrets. */
  warnings?: string[]
}

export interface ItemAdapter<S> {
  item: ItemKind
  /** For Import from zone, when it reads more than a sync. */
  readForImport?(client: CfClient, zone: Zone, profile: Profile<S>): Promise<ReadResult>
  desired(profile: Profile<S>, zone: Zone): Entry[]
  read(client: CfClient, zone: Zone, profile: Profile<S>): Promise<ReadResult>
  /** Must never write an `unavailable` area, not even as empty. */
  apply(client: CfClient, zone: Zone, desired: Entry[], changes: Change[], unavailable: string[]): Promise<void>
  addToProfile(profile: Profile<S>, zone: Zone, change: Change): Profile<S>
  /** True for entries a profile wrote, so leftovers are removed without asking. */
  ownsEntry?(entry: Entry): boolean
  /** Zones with the same key sync one at a time, across items. */
  sharedResourceKey?(zone: Zone): string | undefined
}

/** Only valid for the exact conflict shown. */
export interface OverwriteAnswer {
  key: string
  hash: string
}

export interface ZonePreview {
  zone: Zone
  changes: Change[]
  unavailable: string[]
  warnings: string[]
  /** Blocks apply. */
  failure?: string
}

export interface SyncPreview {
  id: string
  profileId: string
  profileVersion: number
  item: ItemKind
  createdAt: string
  expiresAt: string
  zones: ZonePreview[]
  /** `${zoneId}:${entryKey}` */
  conflictKeys: string[]
  /** apply needs an answer for each. */
  conflicts: OverwriteAnswer[]
  canApply: boolean
}

export type ZoneStatus = 'applied' | 'unchanged' | 'stale' | 'failed'

export interface ZoneResult {
  zoneId: string
  zoneName: string
  status: ZoneStatus
  reason?: string
  /** A failed zone may be partly changed. */
  writeAttempted: boolean
  unavailable: string[]
}

export interface ApplyOutcome {
  results: ZoneResult[]
}

export interface CancelOutcome {
  cancelled: boolean
  /** Add to profile already saved, cancel doesn't undo it. */
  profileSaved: boolean
}
