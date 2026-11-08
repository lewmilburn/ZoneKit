import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import type { Profile } from '../shared/model'
import { MAX_IMPORT_BYTES, type RulesSettings } from '../shared/schemas'
import { UserError, ZoneNotWrittenError } from './errors'
import { createEmailProfileAdapter } from './items/emailProfile'
import { createCloud } from './cloud'
import { errorText } from '../shared/errorText'
import { createAnalyticsHandlers } from './analytics'
import { createParentZoneHandlers, fileLinkStore } from './parentZones'
import { createImportFromZone } from './importFromZone'
import { createSecheadAdapter, createSecurityAdapter } from './items/security'
import { createLogsHandler } from './logs'
import { fileSyncState } from './store/syncState'
import { createSettingsAdapter } from './items/settings'
import { createCachingAdapter } from './items/caching'
import { createSecsetAdapter } from './items/secset'
import { createZoneSecurityTxtHandlers } from './zoneSecurityTxt'
import { createZoneDnssecHandlers } from './zoneDnssec'
import { createZonePurgeHandler } from './zonePurge'
import { createWafAnalyticsHandler } from './wafAnalytics'
import { createZoneSettingsHandlers } from './zoneSettings'
import { createZoneWwwHandlers } from './zoneWww'
import { CACHING_FIELDS, COMPLIANCE_FIELDS, DEV_MODE_FIELDS, NETWORK_FIELDS, SECSET_FIELDS, SPEED_FIELDS, SSL_FIELDS } from '../shared/settingFields'
import { createComplianceHandlers } from './compliance'
import { createNotificationHandlers } from './notifications'
import { createDnsAnalyticsHandler } from './dnsAnalytics'
import { createZoneDnsHandlers } from './zoneDns'
import { createZoneTraceHandler } from './zoneTrace'
import { createZoneMailHandlers } from './zoneMail'
import { createZoneHeaderHandlers } from './securityHeadersZone'
import { createRulesAdapter } from './items/rules'
import { JsonFileListSnapshotStore } from './store/listSnapshots'
import { FileProfileStore } from './store/profileStore'
import type { ItemAdapter } from './sync/adapter'
import { fileLastSynced } from './sync/lastSynced'
import { SyncRunner } from './sync/runner'
import { createProfilesHandlers } from './profilesIpc'
import { CHANNELS, TOKEN_PAGE_URL } from '../shared/ipc'
import { createApiAuth, withSignOutOn401, type Auth } from './auth/apiToken'
import { createTokenStore, encryptionProblem } from './auth/tokenStore'
import { CfClient } from './cloudflare/client'
import { createHandlers } from './ipc'
import { createGuard } from '@app/main/ipcGuard'
import { PAGES } from '@app/shared/tools'
import { createRuleCountHandler, createZoneRulesHandlers } from './zoneRules'
import { createZoneEmailHandlers } from './zoneEmail'

function atomicWrite(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, path)
}

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

function storageProblem(): string | null {
  const linux = process.platform === 'linux'
  return encryptionProblem(
    process.platform,
    safeStorage.isEncryptionAvailable(),
    linux ? safeStorage.getSelectedStorageBackend() : undefined
  )
}

/** Off: no Bulk Redirect list is read or written. */
export const BULK_REDIRECTS_ENABLED = false

function withoutBulk(p: Profile<RulesSettings>): Profile<RulesSettings> {
  const { bulkRedirectList: _list, ...rest } = p.settings
  return { ...p, settings: { ...rest, bulkRedirects: [] } }
}

export function gateBulkRedirects(base: ItemAdapter<RulesSettings>): ItemAdapter<RulesSettings> {
  if (BULK_REDIRECTS_ENABLED) return base
  const refuse = (entries: Array<{ area: string }>): void => {
    if (entries.some((e) => e.area === 'bulkRedirects')) throw new ZoneNotWrittenError('Bulk Redirects are switched off in this build, so nothing was written.')
  }
  // The account lock only protects Bulk Redirect lists, so zones can run in parallel
  const { sharedResourceKey: _lock, ...unlocked } = base
  return {
    ...unlocked,
    desired: (p, z) => base.desired(withoutBulk(p), z),
    read: (c, z, p) => base.read(c, z, withoutBulk(p)),
    ...(base.readForImport ? { readForImport: (c: CfClient, z: Parameters<typeof base.read>[1], p: Profile<RulesSettings>) => (base.readForImport as NonNullable<typeof base.readForImport>)(c, z, withoutBulk(p)) } : {}),
    apply: async (c, z, desired, changes, unavailable) => {
      refuse(desired)
      refuse(changes.flatMap((ch) => ('entry' in ch ? [ch.entry] : 'desired' in ch ? [ch.desired, ch.actual] : [ch.actual])))
      return base.apply(c, z, desired, changes, unavailable)
    },
    // Keeps the stored list fields
    addToProfile: (p, z, change) => {
      const out = base.addToProfile(withoutBulk(p), z, change)
      const { bulkRedirectList: _list, ...rest } = out.settings
      const list = p.settings.bulkRedirectList
      return { ...out, settings: { ...rest, bulkRedirects: p.settings.bulkRedirects, ...(list === undefined ? {} : { bulkRedirectList: list }) } }
    }
  }
}

export interface Services {
  auth: Auth
  client: CfClient
}

export const dataDir = (): string => join(app.getPath('appData'), 'Zonekeeper')

async function cloudResult<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await work() }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}

export function setupServices(devOrigin?: string): Services {
  const dir = dataDir()
  const tokenPath = join(dir, 'api-token.bin')

  const store = createTokenStore(
    {
      isAvailable: () => storageProblem() === null,
      unavailableMessage: storageProblem,
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b)
    },
    {
      read: () => readOrNull(tokenPath),
      write: (d) => atomicWrite(tokenPath, d),
      remove: () => rmSync(tokenPath, { force: true })
    }
  )
  const auth = createApiAuth({ fetch, store })
  const client = new CfClient({ fetch: withSignOutOn401(fetch, auth), getToken: () => auth.getAccessToken() })

  const handlers = createHandlers({
    auth,
    client,
    openTokenPage: () => shell.openExternal(TOKEN_PAGE_URL)
  })
  const guard = createGuard(devOrigin, PAGES.zonekeeper)
  const toWindows = (channel: string, payload?: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w.webContents.getURL().endsWith(PAGES.zonekeeper)) w.webContents.send(channel, payload)
    }
  }
  auth.onChange(() => {
    void handlers.authState().then((state) => {
      toWindows(CHANNELS.authChanged, state)
      if (state.signedIn) void cloud.check()
    })
  })
  ipcMain.handle(CHANNELS.authState, guard(() => handlers.authState()))
  ipcMain.handle(CHANNELS.signInWithToken, guard((raw: unknown) => handlers.signInWithToken(raw)))
  ipcMain.handle(CHANNELS.signOut, guard(() => handlers.signOut()))
  ipcMain.handle(CHANNELS.openTokenPage, guard(() => handlers.openTokenPage()))
  ipcMain.handle(CHANNELS.listZones, guard(() => handlers.listZones()))

  // Every data file reports changes, so ZoneKit Cloud can upload them
  const changed = (): void => cloud.changed()
  const profileStore = new FileProfileStore(join(dir, 'profiles.json'), { onWrite: changed })
  const rules = gateBulkRedirects(
    createRulesAdapter({
      snapshots: new JsonFileListSnapshotStore(join(dir, 'list-snapshots')),
      phases: ['http_request_dynamic_redirect', 'http_request_late_transform', 'http_response_headers_transform']
    })
  )
  const syncState = fileSyncState(join(dir, 'sync-state.json'), changed)
  const adapters = {
    security: createSecurityAdapter() as unknown as ItemAdapter<unknown>,
    sechead: createSecheadAdapter() as unknown as ItemAdapter<unknown>,
    ssl: createSettingsAdapter('ssl', SSL_FIELDS) as unknown as ItemAdapter<unknown>,
    caching: createCachingAdapter() as unknown as ItemAdapter<unknown>,
    speed: createSettingsAdapter('speed', SPEED_FIELDS) as unknown as ItemAdapter<unknown>,
    network: createSettingsAdapter('network', NETWORK_FIELDS) as unknown as ItemAdapter<unknown>,
    compliance: createSettingsAdapter('compliance', COMPLIANCE_FIELDS) as unknown as ItemAdapter<unknown>,
    secset: createSecsetAdapter() as unknown as ItemAdapter<unknown>,
    rules: rules as unknown as ItemAdapter<unknown>,
    email: createEmailProfileAdapter() as unknown as ItemAdapter<unknown>
  }
  const links = fileLinkStore(join(dir, 'parent-links.json'), changed)
  const cloud = createCloud({
    dir,
    client,
    onDownloaded: () => {
      links.reload()
      toWindows(CHANNELS.dataChanged)
    },
    onStatus: (s) => toWindows(CHANNELS.cloudChanged, s)
  })
  ipcMain.handle(CHANNELS.cloudStatus, guard(async () => ({ ok: true, value: cloud.status() })))
  ipcMain.handle(CHANNELS.cloudAccounts, guard(async () => cloudResult(() => cloud.accounts())))
  ipcMain.handle(
    CHANNELS.cloudEnable,
    guard(async (rawId: unknown, rawUse: unknown) => {
      if (typeof rawId !== 'string' || !/^[a-f0-9]{32}$/.test(rawId) || (rawUse !== undefined && rawUse !== null && rawUse !== 'cloud' && rawUse !== 'local')) {
        return { ok: false, error: 'That request was not valid.' }
      }
      return cloudResult(() => cloud.enable(rawId, (rawUse ?? undefined) as 'cloud' | 'local' | undefined))
    })
  )
  ipcMain.handle(CHANNELS.cloudDisable, guard(async () => cloudResult(() => cloud.disable())))
  ipcMain.handle(
    CHANNELS.cloudResolve,
    guard(async (raw: unknown) => (raw === 'cloud' || raw === 'local' ? cloudResult(() => cloud.resolve(raw)) : { ok: false, error: 'That request was not valid.' }))
  )
  const runner = new SyncRunner({
    parentLinks: () => links.read(),
    store: profileStore,
    client,
    adapters,
    onSynced: (profileId, version) => syncState.mark(profileId, version),
    onProgress: (p) => {
      const view = { phase: p.phase, profileId: p.profileId, done: p.done, total: p.total }
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.webContents.getURL().endsWith(PAGES.zonekeeper)) w.webContents.send(CHANNELS.syncProgress, view)
      }
    },
    lastSynced: fileLastSynced(join(dir, 'last-synced.json'), changed),
    now: () => new Date()
  })
  const parentWindow = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? undefined
  const p = createProfilesHandlers({
    store: profileStore,
    links,
    syncedVersion: (profileId) => syncState.syncedVersion(profileId),
    runner,
    now: () => new Date(),
    pickSavePath: async (defaultName) => {
      const opts = { defaultPath: defaultName, filters: [{ name: 'JSON', extensions: ['json'] }] }
      const w = parentWindow()
      const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
      return r.canceled ? undefined : r.filePath
    },
    pickOpenPath: async () => {
      const opts = { properties: ['openFile' as const], filters: [{ name: 'JSON', extensions: ['json'] }] }
      const w = parentWindow()
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? undefined : r.filePaths[0]
    },
    readImportFile: async (path) => {
      if ((await stat(path)).size > MAX_IMPORT_BYTES) throw new UserError('Import file is over the 10 MB limit.')
      return readFile(path, 'utf8')
    },
    writeFile: async (path, text) => atomicWrite(path, text)
  })
  ipcMain.handle(CHANNELS.profilesList, guard((item: unknown) => p.profilesList(item)))
  ipcMain.handle(CHANNELS.syncPending, guard(() => p.syncPending()))
  ipcMain.handle(CHANNELS.profileCreate, guard((item: unknown, name: unknown) => p.profileCreate(item, name)))
  ipcMain.handle(CHANNELS.profileUpdate, guard((raw: unknown) => p.profileUpdate(raw)))
  ipcMain.handle(CHANNELS.profileDelete, guard((raw: unknown) => p.profileDelete(raw)))
  ipcMain.handle(CHANNELS.syncPreview, guard((raw: unknown) => p.syncPreview(raw)))
  ipcMain.handle(CHANNELS.profileDrift, guard((raw: unknown) => p.profileDrift(raw)))
  ipcMain.handle(CHANNELS.syncAddAllToProfile, guard((a: unknown) => p.syncAddAllToProfile(a)))
  ipcMain.handle(CHANNELS.syncAddToProfile, guard((a: unknown, b: unknown, c: unknown) => p.syncAddToProfile(a, b, c)))
  ipcMain.handle(CHANNELS.syncCancel, guard((raw: unknown) => p.syncCancel(raw)))
  ipcMain.handle(CHANNELS.syncApply, guard((a: unknown, b: unknown) => p.syncApply(a, b)))
  ipcMain.handle(CHANNELS.exportProfiles, guard((raw: unknown) => p.exportProfiles(raw)))
  ipcMain.handle(CHANNELS.importPick, guard(() => p.importPick()))
  ipcMain.handle(CHANNELS.importApply, guard((a: unknown, b: unknown) => p.importApply(a, b)))

  const zr = createZoneRulesHandlers({ client, store: profileStore, adapter: rules })
  ipcMain.handle(CHANNELS.zoneRulesGet, guard((raw: unknown) => zr.get(raw)))
  ipcMain.handle(CHANNELS.zoneRuleSave, guard((raw: unknown) => zr.save(raw)))
  ipcMain.handle(CHANNELS.zoneRuleDelete, guard((raw: unknown) => zr.remove(raw)))
  ipcMain.handle(CHANNELS.zoneRuleCreate, guard((raw: unknown) => zr.create(raw)))
  ipcMain.handle(CHANNELS.zoneRuleCount, guard(createRuleCountHandler(client)))

  const ze = createZoneEmailHandlers({ client, store: profileStore })
  ipcMain.handle(CHANNELS.zoneEmailGet, guard((raw: unknown) => ze.get(raw)))
  ipcMain.handle(CHANNELS.zoneEmailSave, guard((raw: unknown) => ze.save(raw)))
  const an = createAnalyticsHandlers({ client })
  ipcMain.handle(CHANNELS.analyticsZone, guard((raw: unknown) => an.zone(raw)))
  ipcMain.handle(CHANNELS.analyticsOverview, guard(() => an.overview()))
  ipcMain.handle(CHANNELS.analyticsGlobal, guard(() => an.global()))
  const parents = createParentZoneHandlers({
    client,
    links,
    rulesProfiles: profileStore as never
  })
  const zoneHeaders = createZoneHeaderHandlers({ client, store: profileStore as never })
  ipcMain.handle(CHANNELS.zoneHeadersGet, guard((raw: unknown) => zoneHeaders.get(raw)))
  ipcMain.handle(CHANNELS.zoneHeadersSave, guard((raw: unknown) => zoneHeaders.save(raw)))
  const zoneDns = createZoneDnsHandlers({ client })
  ipcMain.handle(CHANNELS.zoneDnsGet, guard((raw: unknown) => zoneDns.get(raw)))
  ipcMain.handle(CHANNELS.zoneDnsCreate, guard((raw: unknown) => zoneDns.create(raw)))
  ipcMain.handle(CHANNELS.zoneDnsUpdate, guard((raw: unknown) => zoneDns.update(raw)))
  ipcMain.handle(CHANNELS.zoneDnsDelete, guard((raw: unknown) => zoneDns.remove(raw)))
  const zoneTrace = createZoneTraceHandler({ client })
  ipcMain.handle(CHANNELS.zoneTrace, guard((raw: unknown) => zoneTrace(raw)))
  ipcMain.handle(CHANNELS.analyticsWaf, guard(createWafAnalyticsHandler({ client })))
  ipcMain.handle(CHANNELS.zonePurge, guard(createZonePurgeHandler({ client })))
  const dnssec = createZoneDnssecHandlers({ client })
  ipcMain.handle(CHANNELS.zoneDnssecGet, guard((raw: unknown) => dnssec.dnssecGet(raw)))
  ipcMain.handle(CHANNELS.zoneDnssecSave, guard((raw: unknown) => dnssec.dnssecSave(raw)))
  ipcMain.handle(CHANNELS.zoneDmarcReportsGet, guard((raw: unknown) => dnssec.reportsGet(raw)))
  ipcMain.handle(CHANNELS.zoneDmarcReportsSave, guard((raw: unknown) => dnssec.reportsSave(raw)))
  const zoneSecurityTxt = createZoneSecurityTxtHandlers({ client, store: profileStore as never })
  ipcMain.handle(CHANNELS.zoneSecurityTxtGet, guard((raw: unknown) => zoneSecurityTxt.get(raw)))
  ipcMain.handle(CHANNELS.zoneSecurityTxtSave, guard((raw: unknown) => zoneSecurityTxt.save(raw)))
  const zoneSecset = createZoneSettingsHandlers({ item: 'secset', fields: SECSET_FIELDS, client, store: profileStore as never })
  ipcMain.handle(CHANNELS.zoneSecsetGet, guard((raw: unknown) => zoneSecset.get(raw)))
  ipcMain.handle(CHANNELS.zoneSecsetSave, guard((raw: unknown) => zoneSecset.save(raw)))
  const zoneSpeed = createZoneSettingsHandlers({ item: 'speed', fields: SPEED_FIELDS, client, store: profileStore as never })
  ipcMain.handle(CHANNELS.zoneSpeedGet, guard((raw: unknown) => zoneSpeed.get(raw)))
  ipcMain.handle(CHANNELS.zoneSpeedSave, guard((raw: unknown) => zoneSpeed.save(raw)))
  const zoneCaching = createZoneSettingsHandlers({ item: 'caching', fields: CACHING_FIELDS, client, store: profileStore as never })
  ipcMain.handle(CHANNELS.zoneCachingGet, guard((raw: unknown) => zoneCaching.get(raw)))
  ipcMain.handle(CHANNELS.zoneCachingSave, guard((raw: unknown) => zoneCaching.save(raw)))
  const zoneNetwork = createZoneSettingsHandlers({ item: 'network', fields: NETWORK_FIELDS, client, store: profileStore as never })
  ipcMain.handle(CHANNELS.zoneNetworkGet, guard((raw: unknown) => zoneNetwork.get(raw)))
  ipcMain.handle(CHANNELS.zoneNetworkSave, guard((raw: unknown) => zoneNetwork.save(raw)))
  // Never synced: it expires after 3 hours
  const zoneDevMode = createZoneSettingsHandlers({ item: 'caching', fields: DEV_MODE_FIELDS, client, store: profileStore as never })
  ipcMain.handle(CHANNELS.zoneDevModeGet, guard((raw: unknown) => zoneDevMode.get(raw)))
  ipcMain.handle(CHANNELS.zoneDevModeSave, guard((raw: unknown) => zoneDevMode.save(raw)))
  const zoneCompliance = createZoneSettingsHandlers({ item: 'compliance', fields: COMPLIANCE_FIELDS, client, store: profileStore as never })
  ipcMain.handle(CHANNELS.zoneComplianceGet, guard((raw: unknown) => zoneCompliance.get(raw)))
  ipcMain.handle(CHANNELS.zoneComplianceSave, guard((raw: unknown) => zoneCompliance.save(raw)))
  const notifications = createNotificationHandlers({ client })
  ipcMain.handle(CHANNELS.notificationsList, guard(() => notifications.list()))
  ipcMain.handle(CHANNELS.notificationSave, guard((raw: unknown) => notifications.save(raw)))
  ipcMain.handle(CHANNELS.notificationDelete, guard((raw: unknown) => notifications.remove(raw)))
  const compliance = createComplianceHandlers({ client })
  ipcMain.handle(CHANNELS.zoneCsamGet, guard((raw: unknown) => compliance.get(raw)))
  ipcMain.handle(CHANNELS.zoneCsamSave, guard((raw: unknown) => compliance.save(raw)))
  ipcMain.handle(CHANNELS.analyticsDns, guard(createDnsAnalyticsHandler({ client })))
  const zoneWww = createZoneWwwHandlers({ client })
  ipcMain.handle(CHANNELS.zoneWwwGet, guard((raw: unknown) => zoneWww.get(raw)))
  ipcMain.handle(CHANNELS.zoneWwwSave, guard((raw: unknown) => zoneWww.save(raw)))
  const zoneSsl = createZoneSettingsHandlers({ item: 'ssl', fields: SSL_FIELDS, client, store: profileStore as never })
  ipcMain.handle(CHANNELS.zoneSslGet, guard((raw: unknown) => zoneSsl.get(raw)))
  ipcMain.handle(CHANNELS.zoneSslSave, guard((raw: unknown) => zoneSsl.save(raw)))
  const zoneMail = createZoneMailHandlers({ client, store: profileStore as never })
  ipcMain.handle(CHANNELS.zoneMailGet, guard((raw: unknown) => zoneMail.get(raw)))
  ipcMain.handle(CHANNELS.zoneMailSave, guard((raw: unknown) => zoneMail.save(raw)))
  ipcMain.handle(CHANNELS.zoneMailDelete, guard((raw: unknown) => zoneMail.remove(raw)))
  const logs = createLogsHandler({ client })
  ipcMain.handle(CHANNELS.logsQuery, guard((raw: unknown) => logs(raw)))
  const importZone = createImportFromZone({ client, store: profileStore as never, adapters })
  ipcMain.handle(CHANNELS.profileImportZone, guard((raw: unknown) => importZone(raw)))
  ipcMain.handle(CHANNELS.parentLinks, guard(() => parents.links()))
  ipcMain.handle(CHANNELS.parentPreview, guard((raw: unknown) => parents.preview(raw)))
  ipcMain.handle(CHANNELS.parentApply, guard((raw: unknown) => parents.apply(raw)))
  ipcMain.handle(CHANNELS.parentRemove, guard((raw: unknown) => parents.remove(raw)))

  return { auth, client }
}
