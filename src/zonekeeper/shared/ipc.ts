import type { Change } from './model'
import type { SecurityTxt } from './schemas'

export const MENUS = ['security', 'rules', 'email', 'speed', 'network', 'compliance', 'notifications', 'analytics'] as const
export type Menu = (typeof MENUS)[number]

/** The only external page the app opens. */
export const TOKEN_PAGE_URL = 'https://dash.cloudflare.com/profile/api-tokens'

export const CHANNELS = {
  authState: 'zk:auth:state',
  signInWithToken: 'zk:auth:sign-in-token',
  signOut: 'zk:auth:sign-out',
  openTokenPage: 'zk:open-token-page',
  listZones: 'zk:zones:list',
  profilesList: 'zk:profiles:list',
  syncPending: 'zk:sync:pending',
  profileCreate: 'zk:profiles:create',
  profileUpdate: 'zk:profiles:update',
  profileDelete: 'zk:profiles:delete',
  syncPreview: 'zk:sync:preview',
  syncAddToProfile: 'zk:sync:add-to-profile',
  syncAddAllToProfile: 'zk:sync:add-all-to-profile',
  syncCancel: 'zk:sync:cancel',
  syncApply: 'zk:sync:apply',
  exportProfiles: 'zk:transfer:export',
  importPick: 'zk:transfer:import-pick',
  importApply: 'zk:transfer:import-apply',
  zoneRulesGet: 'zk:zone-rules:get',
  zoneRuleSave: 'zk:zone-rules:save',
  zoneRuleDelete: 'zk:zone-rules:delete',
  zoneRuleCreate: 'zk:zone-rules:create',
  zoneEmailGet: 'zk:zone-email:get',
  zoneEmailSave: 'zk:zone-email:save',
  analyticsZone: 'zk:analytics:zone',
  analyticsOverview: 'zk:analytics:overview',
  analyticsGlobal: 'zk:analytics:global',
  profileImportZone: 'zk:profiles:import-zone',
  logsQuery: 'zk:logs:query',
  zoneDnsGet: 'zk:zone-dns:get',
  zoneDnsCreate: 'zk:zone-dns:create',
  zoneDnsUpdate: 'zk:zone-dns:update',
  zoneDnsDelete: 'zk:zone-dns:delete',
  zoneTrace: 'zk:zone-trace',
  zonePurge: 'zk:zone-purge',
  profileDrift: 'zk:profiles:drift',
  zoneRuleCount: 'zk:zone-rules:count',
  notificationsList: 'zk:notifications:list',
  notificationSave: 'zk:notifications:save',
  notificationDelete: 'zk:notifications:delete',
  analyticsWaf: 'zk:analytics:waf',
  analyticsDns: 'zk:analytics:dns',
  zoneNetworkGet: 'zk:zone-network:get',
  zoneNetworkSave: 'zk:zone-network:save',
  zoneDevModeGet: 'zk:zone-dev-mode:get',
  zoneDevModeSave: 'zk:zone-dev-mode:save',
  zoneComplianceGet: 'zk:zone-compliance:get',
  zoneComplianceSave: 'zk:zone-compliance:save',
  zoneCsamGet: 'zk:zone-csam:get',
  zoneCsamSave: 'zk:zone-csam:save',
  zoneDnssecGet: 'zk:zone-dnssec:get',
  zoneDnssecSave: 'zk:zone-dnssec:save',
  zoneDmarcReportsGet: 'zk:zone-dmarc-reports:get',
  zoneDmarcReportsSave: 'zk:zone-dmarc-reports:save',
  zoneSecurityTxtGet: 'zk:zone-security-txt:get',
  zoneSecurityTxtSave: 'zk:zone-security-txt:save',
  zoneSecsetGet: 'zk:zone-secset:get',
  zoneSecsetSave: 'zk:zone-secset:save',
  zoneSpeedGet: 'zk:zone-speed:get',
  zoneSpeedSave: 'zk:zone-speed:save',
  zoneCachingGet: 'zk:zone-caching:get',
  zoneCachingSave: 'zk:zone-caching:save',
  zoneWwwGet: 'zk:zone-www:get',
  zoneWwwSave: 'zk:zone-www:save',
  zoneSslGet: 'zk:zone-ssl:get',
  zoneSslSave: 'zk:zone-ssl:save',
  zoneMailGet: 'zk:zone-mail:get',
  zoneMailSave: 'zk:zone-mail:save',
  zoneMailDelete: 'zk:zone-mail:delete',
  zoneHeadersGet: 'zk:zone-headers:get',
  zoneHeadersSave: 'zk:zone-headers:save',
  parentLinks: 'zk:parent:links',
  parentPreview: 'zk:parent:preview',
  parentApply: 'zk:parent:apply',
  parentRemove: 'zk:parent:remove',
  cloudStatus: 'zk:cloud:status',
  cloudAccounts: 'zk:cloud:accounts',
  cloudEnable: 'zk:cloud:enable',
  cloudDisable: 'zk:cloud:disable',
  cloudResolve: 'zk:cloud:resolve',
  /** Main to renderer. */
  authChanged: 'zk:auth:changed',
  syncProgress: 'zk:sync:progress',
  cloudChanged: 'zk:cloud:changed',
  dataChanged: 'zk:data:changed'
} as const

export interface CloudAccount {
  id: string
  name: string
}

export interface CloudActivity {
  at: string
  level: 'good' | 'warn' | 'bad' | 'info'
  text: string
}

export interface CloudStatus {
  enabled: boolean
  accountName: string
  savedAt: string | null
  state: 'idle' | 'saving' | 'error'
  error: string | null
  /** This computer and the cloud both changed. */
  clash: boolean
  namespace: string
  key: string
  revision: number
  /** Size of the stored value. */
  bytes: number | null
  checkedAt: string | null
  /** Newest first. */
  activity: CloudActivity[]
}

export interface SyncProgressView {
  phase: 'preview' | 'apply'
  profileId: string
  done: number
  total: number
}

export const PROFILE_ITEMS = ['security', 'sechead', 'secset', 'rules', 'email', 'ssl', 'caching', 'speed', 'network', 'compliance'] as const
export type ProfileItem = (typeof PROFILE_ITEMS)[number]

/** Never contains the token. */
export interface AuthState {
  signedIn: boolean
  /** Set when Cloudflare rejected the stored token. */
  notice: string | null
}


export type IpcResult<T = void> = { ok: true; value: T } | { ok: false; error: string; profileSaved?: boolean }

export interface ZoneSummary {
  id: string
  name: string
  status: string | null
  plan: string | null
}

export interface ProfileDto {
  id: string
  item: ProfileItem
  name: string
  version: number
  zoneIds: string[]
  settings: unknown
  updatedAt: string
}

export interface ZoneRef {
  id: string
  name: string
}

export interface PreviewZoneView {
  zone: ZoneRef
  changes: Change[]
  unavailable: string[]
  warnings: string[]
  failure?: string
}

export interface PreviewView {
  id: string
  profileId: string
  item: string
  expiresAt: string
  zones: PreviewZoneView[]
  /** Keyed `${zoneId}:${entryKey}`. */
  conflicts: Array<{ key: string; hash: string }>
  canApply: boolean
}

export interface ZoneResultView {
  zoneId: string
  zoneName: string
  status: 'applied' | 'unchanged' | 'stale' | 'failed'
  reason?: string
  writeAttempted: boolean
  unavailable: string[]
}

export interface ApplyView {
  results: ZoneResultView[]
}

export interface ImportSummary {
  importId: string
  added: Array<{ id: string; name: string; item: string }>
  replaced: Array<{ id: string; name: string; item: string }>
  zoneClashes: Array<{ zoneId: string; item: string; profileId: string }>
}

export interface ZoneRuleView {
  id: string
  ref: string | null
  description: string
  expression: string
  action: string
  enabled: boolean
  actionParameters: unknown
  /** Sent back on save to detect edits. */
  fingerprint: string
  /** Null if editable. */
  readOnlyNote: string | null
}

export interface ZonePhaseView {
  phase: string
  /** 'unavailable': the token can't read it. */
  status: 'ok' | 'unavailable'
  rules: ZoneRuleView[]
}

export interface ZoneRulesView {
  zoneId: string
  zoneName: string
  profileName: string | null
  phases: ZonePhaseView[]
}

export interface ZoneRuleSaveInput {
  zoneId: string
  phase: string
  ruleId: string
  fingerprint: string
  description: string
  expression: string
  enabled: boolean
  /** Omit to keep the current ones. */
  actionParameters?: Record<string, unknown>
  confirmed: true
}

export interface ZoneEmailRecordView {
  id: string
  type: string
  name: string
  /** The joined value for TXT, the target for CNAME. */
  content: string
  /** Sent back on save to detect edits. */
  fingerprint: string
  /** Null if editable. */
  readOnlyNote: string | null
}

export interface ZoneEmailAreaView {
  area: 'spf' | 'dmarc' | 'dkim' | 'tlsrpt' | 'bimi'
  /** 'unavailable': the token can't read it. */
  status: 'ok' | 'unavailable'
  records: ZoneEmailRecordView[]
}

export interface ZoneEmailView {
  zoneId: string
  zoneName: string
  profileName: string | null
  areas: ZoneEmailAreaView[]
  warnings: string[]
}

export interface ZoneEmailSaveInput {
  zoneId: string
  recordId: string
  fingerprint: string
  content: string
  confirmed: true
}

export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'CAA', 'SRV'] as const

export interface DnsRecordInput {
  type: (typeof DNS_TYPES)[number]
  name: string
  content: string
  ttl: number
  proxied: boolean
  priority?: number
}

export interface DnsRecordView {
  id: string
  type: string
  name: string
  content: string
  ttl: number
  proxied: boolean
  proxiable: boolean
  priority?: number
  fingerprint: string
}

export interface TraceStep {
  phase: string
  description: string
  expression: string
  action: string
  matched: boolean
}

export interface TraceResult {
  zoneName: string
  statusCode?: number
  steps: TraceStep[]
}

export interface DnssecView {
  status: string
  ds: string | null
  keyTag: string | null
  algorithm: string | null
  digestType: string | null
  digest: string | null
  multiSigner: boolean
  presigned: boolean
  nsec3: boolean
}

export interface DmarcReportsView {
  enabled: boolean
  status: string | null
}

export interface ZoneSecurityTxtView {
  value: SecurityTxt | null
  profileName: string | null
}

export type WwwDirection = 'off' | 'toApex' | 'toWww'

export interface ZoneSslView {
  /** Null value: unreadable or not on the plan. */
  fields: Array<{ field: string; value: string | null; profileValue: string | null; readOnlyNote: string | null }>
}

export interface ZoneMailView {
  profileName: string | null
  records: Array<{ id: string; content: string; priority: number; fingerprint: string; readOnlyNote: string | null }>
}

export interface LogRow {
  time: string
  ip: string
  method: string
  host: string
  uri: string
  status: string
  country: string
  userAgent: string
  referer: string
  cache: string
  bytes: string
  asn: string
  protocol: string
  rayId: string
  ttfbMs: string
  contentType: string
}

/** Child zone ID to parent zone ID. */
export type ParentLinks = Record<string, string>

export interface ParentPreview {
  childId: string
  parentId: string
  childName: string
  parentName: string
  fingerprint: string
  /** Removed by Overwrite. */
  conflicts: Array<{ description: string; expression: string }>
  /** Made so the root is proxied. */
  dnsChange: string | null
  warnings: string[]
}

export const ANALYTICS_RANGES = [24, 72, 168] as const
/** Every plan allows this range. */
export const ANALYTICS_OVERVIEW_HOURS = 24

export interface AnalyticsCount {
  label: string
  count: number
}

export interface AnalyticsSecurityEvent {
  datetime: string
  action: string
  source: string
  clientIP: string
  country: string
  path: string
}

export interface AlertType {
  type: string
  name: string
  description: string
  /** e.g. "SSL/TLS". */
  group: string
  /** Can be limited to some zones. */
  zoneFilter: boolean
}

export interface NotificationPolicy {
  id: string
  name: string
  alertType: string
  enabled: boolean
  emails: string[]
  /** Empty: every zone. */
  zoneIds: string[]
}

export interface NotificationsView {
  accountId: string
  types: AlertType[]
  policies: NotificationPolicy[]
}

export interface DriftView {
  profileId: string
  inSync: boolean
  zones: Array<{ zoneId: string; zoneName: string; differences: string[]; failure?: string; unavailable: string[] }>
}

export interface RuleCounts {
  waf: number
  /** Redirects, transforms and cache rules. */
  rules: number
}

export interface LogsView {
  rows: LogRow[]
  failed: Array<{ zoneId: string; error: string }>
}

export interface CsamView {
  enabled: boolean
  /** Masked by Cloudflare. */
  email: string | null
  emailState: string | null
  /** False if locked by Trust and Safety. */
  editable: boolean
}

export interface DnsAnalytics {
  hours: number
  total: number
  hourly: Array<{ hour: string; count: number }>
  types: AnalyticsCount[]
  codes: AnalyticsCount[]
  names: AnalyticsCount[]
  cached: AnalyticsCount[]
  colos: AnalyticsCount[]
  protocols: AnalyticsCount[]
  ipVersions: AnalyticsCount[]
  /** Breakdowns that failed, with why. */
  missing: string[]
}

export const WAF_RANGES = [1, 6, 24, 72, 168] as const

export interface WafEvent {
  datetime: string
  action: string
  source: string
  rule: string
  ruleId: string
  rayId: string
  clientIP: string
  country: string
  asn: string
  method: string
  host: string
  path: string
  userAgent: string
  status: string
}

export interface WafAnalytics {
  requestedHours: number
  /** Less than requested if the plan limits it. */
  hours: number
  total: number
  actions: AnalyticsCount[]
  hourly: Array<{ hour: string; byAction: Record<string, number> }>
  sources: AnalyticsCount[]
  rules: AnalyticsCount[]
  ips: AnalyticsCount[]
  countries: AnalyticsCount[]
  asns: AnalyticsCount[]
  paths: AnalyticsCount[]
  hosts: AnalyticsCount[]
  userAgents: AnalyticsCount[]
  methods: AnalyticsCount[]
  events: WafEvent[]
  failedZones: number
  /** Counted from raw events: grouped counts need a paid plan. */
  sampled: boolean
  failedReason?: string
}

export interface ZoneAnalytics {
  zoneId: string
  requestedHours: number
  /** Less than requested if the plan limits it. */
  hours: number
  requests: number
  visits: number
  bytes: number
  hourly: Array<{ hour: string; count: number }>
  statuses: AnalyticsCount[]
  paths: AnalyticsCount[]
  countries: AnalyticsCount[]
  /** Null on failure: see securityError. */
  securityEvents: AnalyticsSecurityEvent[] | null
  securityError: string | null
  /** All zones view: zones missing from the totals. */
  failedZones?: number
  /** Refused breakdowns are empty and listed in `missing`. */
  extra?: {
    bandwidthHourly: Array<{ hour: string; count: number }>
    cache: AnalyticsCount[]
    contentTypes: AnalyticsCount[]
    protocols: AnalyticsCount[]
    devices: AnalyticsCount[]
    browsers: AnalyticsCount[]
    os: AnalyticsCount[]
    methods: AnalyticsCount[]
    hosts: AnalyticsCount[]
    referers: AnalyticsCount[]
    missing: string[]
  }
}

export interface AnalyticsOverviewRow {
  zoneId: string
  zoneName: string
  /** Null on failure: see error. */
  requests: number | null
  bytes: number | null
  error: string | null
}

/** Exposed as `window.zonekeeper`. */
export interface ZonekeeperApi {
  readonly version: string
  getAuthState(): Promise<AuthState>
  signInWithToken(token: string): Promise<IpcResult<AuthState>>
  signOut(): Promise<IpcResult<AuthState>>
  openTokenPage(): Promise<void>
  listZones(): Promise<IpcResult<ZoneSummary[]>>
  profilesList(item: ProfileItem): Promise<IpcResult<ProfileDto[]>>
  syncPending(): Promise<IpcResult<ProfileDto[]>>
  profileCreate(item: ProfileItem, name: string): Promise<IpcResult<ProfileDto>>
  profileUpdate(p: { id: string; name: string; zoneIds: string[]; settings: unknown }): Promise<IpcResult<ProfileDto>>
  profileDelete(id: string): Promise<IpcResult>
  syncPreview(profileId: string): Promise<IpcResult<PreviewView>>
  syncAddToProfile(previewId: string, key: string, zoneId: string): Promise<IpcResult<PreviewView>>
  syncAddAllToProfile(previewId: string): Promise<IpcResult<PreviewView>>
  syncCancel(previewId: string): Promise<IpcResult<{ cancelled: boolean; profileSaved: boolean }>>
  syncApply(previewId: string, overwrites: Array<{ key: string; hash: string }>): Promise<IpcResult<ApplyView>>
  /** Opens a save dialog, false if closed. */
  exportProfiles(ids: string[]): Promise<IpcResult<boolean>>
  /** Opens an open dialog, null if closed. */
  importPick(): Promise<IpcResult<ImportSummary | null>>
  importApply(importId: string, replaceIds: string[]): Promise<IpcResult>
  zoneRulesGet(zoneId: string): Promise<IpcResult<ZoneRulesView>>
  zoneRuleSave(input: ZoneRuleSaveInput): Promise<IpcResult<ZoneRulesView>>
  zoneRuleDelete(input: { zoneId: string; phase: string; ruleId: string; fingerprint: string; confirmed: true }): Promise<IpcResult<ZoneRulesView>>
  zoneRuleCreate(input: {
    zoneId: string
    phase: string
    rule: { description?: string; expression: string; action: string; action_parameters?: Record<string, unknown>; enabled: boolean }
    confirmed: true
  }): Promise<IpcResult<ZoneRulesView>>
  zoneEmailGet(zoneId: string): Promise<IpcResult<ZoneEmailView>>
  zoneEmailSave(input: ZoneEmailSaveInput): Promise<IpcResult<ZoneEmailView>>
  analyticsZone(input: { zoneId: string; hours: number }): Promise<IpcResult<ZoneAnalytics>>
  analyticsOverview(): Promise<IpcResult<AnalyticsOverviewRow[]>>
  analyticsGlobal(): Promise<IpcResult<ZoneAnalytics>>
  profileImportZone(input: { profileId: string; zoneId: string }): Promise<IpcResult<{ settings: unknown; unavailable: string[] }>>
  logsQuery(input: { zoneIds: string[]; hours: 1 | 6 | 24 }): Promise<IpcResult<LogsView>>
  zoneDnsGet(zoneId: string): Promise<IpcResult<DnsRecordView[]>>
  zoneDnsCreate(input: { zoneId: string; record: DnsRecordInput; confirmed: true }): Promise<IpcResult<DnsRecordView[]>>
  zoneDnsUpdate(input: { zoneId: string; recordId: string; fingerprint: string; record: DnsRecordInput; confirmed: true }): Promise<IpcResult<DnsRecordView[]>>
  zoneDnsDelete(input: { zoneId: string; recordId: string; fingerprint: string; confirmed: true }): Promise<IpcResult<DnsRecordView[]>>
  zoneTrace(input: { url: string; method: string; country?: string }): Promise<IpcResult<TraceResult>>
  profileDrift(profileId: string): Promise<IpcResult<DriftView>>
  zoneRuleCount(zoneId: string): Promise<IpcResult<RuleCounts>>
  notificationsList(): Promise<IpcResult<NotificationsView[]>>
  notificationSave(input: { accountId: string; policyId?: string; name: string; alertType: string; enabled: boolean; emails: string[]; zoneIds: string[]; confirmed: true }): Promise<IpcResult<NotificationsView>>
  notificationDelete(input: { accountId: string; policyId: string; confirmed: true }): Promise<IpcResult<NotificationsView>>
  analyticsWaf(input: { zoneIds: string[]; hours: (typeof WAF_RANGES)[number] }): Promise<IpcResult<WafAnalytics>>
  analyticsDns(input: { zoneIds: string[]; hours: (typeof WAF_RANGES)[number] }): Promise<IpcResult<DnsAnalytics>>
  zoneNetworkGet(zoneId: string): Promise<IpcResult<ZoneSslView>>
  zoneNetworkSave(input: { zoneId: string; field: string; value: string; expected: string; confirmed: true }): Promise<IpcResult<ZoneSslView>>
  zoneDevModeGet(zoneId: string): Promise<IpcResult<ZoneSslView>>
  zoneDevModeSave(input: { zoneId: string; field: string; value: string; expected: string; confirmed: true }): Promise<IpcResult<ZoneSslView>>
  zoneComplianceGet(zoneId: string): Promise<IpcResult<ZoneSslView>>
  zoneComplianceSave(input: { zoneId: string; field: string; value: string; expected: string; confirmed: true }): Promise<IpcResult<ZoneSslView>>
  zoneCsamGet(zoneId: string): Promise<IpcResult<CsamView>>
  /** Email only, on/off uses zoneComplianceSave. */
  zoneCsamSave(input: { zoneId: string; email: string; confirmed: true }): Promise<IpcResult<CsamView>>
  zonePurge(input: { zoneId: string; kind: 'everything' | 'files' | 'hosts' | 'prefixes' | 'tags'; values: string[]; mode?: 'purge' | 'invalidate'; confirmed: true }): Promise<IpcResult<null>>
  zoneDnssecGet(zoneId: string): Promise<IpcResult<DnssecView>>
  zoneDnssecSave(input: { zoneId: string; enable?: boolean; multiSigner?: boolean; presigned?: boolean; nsec3?: boolean; confirmed: true }): Promise<IpcResult<DnssecView>>
  zoneDmarcReportsGet(zoneId: string): Promise<IpcResult<DmarcReportsView>>
  zoneDmarcReportsSave(input: { zoneId: string; enable: boolean; confirmed: true }): Promise<IpcResult<DmarcReportsView>>
  zoneSecurityTxtGet(zoneId: string): Promise<IpcResult<ZoneSecurityTxtView>>
  zoneSecurityTxtSave(input: { zoneId: string; value: unknown; confirmed: true }): Promise<IpcResult<ZoneSecurityTxtView>>
  zoneSecsetGet(zoneId: string): Promise<IpcResult<ZoneSslView>>
  zoneSecsetSave(input: { zoneId: string; field: string; value: string; expected: string; confirmed: true }): Promise<IpcResult<ZoneSslView>>
  zoneSpeedGet(zoneId: string): Promise<IpcResult<ZoneSslView>>
  zoneSpeedSave(input: { zoneId: string; field: string; value: string; expected: string; confirmed: true }): Promise<IpcResult<ZoneSslView>>
  zoneCachingGet(zoneId: string): Promise<IpcResult<ZoneSslView>>
  zoneCachingSave(input: { zoneId: string; field: string; value: string; expected: string; confirmed: true }): Promise<IpcResult<ZoneSslView>>
  zoneWwwGet(zoneId: string): Promise<IpcResult<WwwDirection>>
  zoneWwwSave(input: { zoneId: string; direction: WwwDirection; confirmed: true }): Promise<IpcResult<WwwDirection>>
  zoneSslGet(zoneId: string): Promise<IpcResult<ZoneSslView>>
  zoneSslSave(input: { zoneId: string; field: string; value: string; expected: string; confirmed: true }): Promise<IpcResult<ZoneSslView>>
  zoneMailGet(zoneId: string): Promise<IpcResult<ZoneMailView>>
  zoneMailSave(input: { zoneId: string; recordId: string; fingerprint: string; content: string; priority: number; confirmed: true }): Promise<IpcResult<ZoneMailView>>
  zoneMailDelete(input: { zoneId: string; recordId: string; fingerprint: string; confirmed: true }): Promise<IpcResult<ZoneMailView>>
  zoneHeadersGet(zoneId: string): Promise<IpcResult<Record<string, string>>>
  zoneHeadersSave(input: { zoneId: string; headers: Record<string, string>; confirmed: true }): Promise<IpcResult<Record<string, string>>>
  parentLinks(): Promise<IpcResult<ParentLinks>>
  parentPreview(input: { childId: string; parentId: string }): Promise<IpcResult<ParentPreview>>
  parentApply(input: { childId: string; parentId: string; fingerprint: string; overwrite: boolean }): Promise<IpcResult<ParentLinks>>
  parentRemove(input: { childId: string; confirmed: true }): Promise<IpcResult<ParentLinks>>
  /** Returns an unsubscribe function. */
  onAuthChanged(listener: (state: AuthState) => void): () => void
  /** Returns an unsubscribe function. */
  onSyncProgress(listener: (p: SyncProgressView) => void): () => void
  cloudStatus(): Promise<IpcResult<CloudStatus>>
  cloudAccounts(): Promise<IpcResult<CloudAccount[]>>
  /** `use` picks which copy wins when both exist. */
  cloudEnable(accountId: string, use?: 'cloud' | 'local'): Promise<IpcResult<CloudStatus>>
  cloudDisable(): Promise<IpcResult<CloudStatus>>
  cloudResolve(use: 'cloud' | 'local'): Promise<IpcResult<CloudStatus>>
  onCloudChanged(listener: (s: CloudStatus) => void): () => void
  /** Data was replaced by a cloud download or an import. */
  onDataChanged(listener: () => void): () => void
}
