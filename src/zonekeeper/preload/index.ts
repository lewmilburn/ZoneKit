import { contextBridge, ipcRenderer } from 'electron'
import { exposeAppApi } from '@app/preload/appApi'
import { CHANNELS, type AuthState, type CloudStatus, type SyncProgressView, type ZonekeeperApi } from '../shared/ipc'

exposeAppApi()

const api: ZonekeeperApi = {
  version: '0.1.0',
  getAuthState: () => ipcRenderer.invoke(CHANNELS.authState),
  signInWithToken: (token) => ipcRenderer.invoke(CHANNELS.signInWithToken, String(token)),
  signOut: () => ipcRenderer.invoke(CHANNELS.signOut),
  openTokenPage: () => ipcRenderer.invoke(CHANNELS.openTokenPage),
  listZones: () => ipcRenderer.invoke(CHANNELS.listZones),
  profilesList: (item) => ipcRenderer.invoke(CHANNELS.profilesList, item),
  syncPending: () => ipcRenderer.invoke(CHANNELS.syncPending),
  profileCreate: (item, name) => ipcRenderer.invoke(CHANNELS.profileCreate, item, name),
  profileUpdate: (p) => ipcRenderer.invoke(CHANNELS.profileUpdate, p),
  profileDelete: (id) => ipcRenderer.invoke(CHANNELS.profileDelete, id),
  syncPreview: (id) => ipcRenderer.invoke(CHANNELS.syncPreview, id),
  syncAddAllToProfile: (previewId) => ipcRenderer.invoke(CHANNELS.syncAddAllToProfile, previewId),
  syncAddToProfile: (previewId, key, zoneId) => ipcRenderer.invoke(CHANNELS.syncAddToProfile, previewId, key, zoneId),
  syncCancel: (id) => ipcRenderer.invoke(CHANNELS.syncCancel, id),
  syncApply: (previewId, overwrites) => ipcRenderer.invoke(CHANNELS.syncApply, previewId, overwrites),
  exportProfiles: (ids) => ipcRenderer.invoke(CHANNELS.exportProfiles, ids),
  importPick: () => ipcRenderer.invoke(CHANNELS.importPick),
  importApply: (importId, replaceIds) => ipcRenderer.invoke(CHANNELS.importApply, importId, replaceIds),
  zoneRulesGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneRulesGet, zoneId),
  zoneRuleSave: (input) => ipcRenderer.invoke(CHANNELS.zoneRuleSave, input),
  zoneRuleDelete: (input) => ipcRenderer.invoke(CHANNELS.zoneRuleDelete, input),
  zoneRuleCreate: (input) => ipcRenderer.invoke(CHANNELS.zoneRuleCreate, input),
  zoneEmailGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneEmailGet, zoneId),
  zoneEmailSave: (input) => ipcRenderer.invoke(CHANNELS.zoneEmailSave, input),
  analyticsZone: (input) => ipcRenderer.invoke(CHANNELS.analyticsZone, input),
  analyticsOverview: () => ipcRenderer.invoke(CHANNELS.analyticsOverview),
  analyticsGlobal: () => ipcRenderer.invoke(CHANNELS.analyticsGlobal),
  profileImportZone: (input) => ipcRenderer.invoke(CHANNELS.profileImportZone, input),
  zoneDnsGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneDnsGet, zoneId),
  zoneDnsCreate: (input) => ipcRenderer.invoke(CHANNELS.zoneDnsCreate, input),
  zoneDnsUpdate: (input) => ipcRenderer.invoke(CHANNELS.zoneDnsUpdate, input),
  zoneDnsDelete: (input) => ipcRenderer.invoke(CHANNELS.zoneDnsDelete, input),
  zoneTrace: (input) => ipcRenderer.invoke(CHANNELS.zoneTrace, input),
  profileDrift: (id) => ipcRenderer.invoke(CHANNELS.profileDrift, id),
  zoneRuleCount: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneRuleCount, zoneId),
  notificationsList: () => ipcRenderer.invoke(CHANNELS.notificationsList),
  notificationSave: (input) => ipcRenderer.invoke(CHANNELS.notificationSave, input),
  notificationDelete: (input) => ipcRenderer.invoke(CHANNELS.notificationDelete, input),
  analyticsWaf: (input) => ipcRenderer.invoke(CHANNELS.analyticsWaf, input),
  analyticsDns: (input) => ipcRenderer.invoke(CHANNELS.analyticsDns, input),
  zoneNetworkGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneNetworkGet, zoneId),
  zoneNetworkSave: (input) => ipcRenderer.invoke(CHANNELS.zoneNetworkSave, input),
  zoneDevModeGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneDevModeGet, zoneId),
  zoneDevModeSave: (input) => ipcRenderer.invoke(CHANNELS.zoneDevModeSave, input),
  zoneComplianceGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneComplianceGet, zoneId),
  zoneComplianceSave: (input) => ipcRenderer.invoke(CHANNELS.zoneComplianceSave, input),
  zoneCsamGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneCsamGet, zoneId),
  zoneCsamSave: (input) => ipcRenderer.invoke(CHANNELS.zoneCsamSave, input),
  zonePurge: (input) => ipcRenderer.invoke(CHANNELS.zonePurge, input),
  zoneDnssecGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneDnssecGet, zoneId),
  zoneDnssecSave: (input) => ipcRenderer.invoke(CHANNELS.zoneDnssecSave, input),
  zoneDmarcReportsGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneDmarcReportsGet, zoneId),
  zoneDmarcReportsSave: (input) => ipcRenderer.invoke(CHANNELS.zoneDmarcReportsSave, input),
  zoneSecurityTxtGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneSecurityTxtGet, zoneId),
  zoneSecurityTxtSave: (input) => ipcRenderer.invoke(CHANNELS.zoneSecurityTxtSave, input),
  zoneSecsetGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneSecsetGet, zoneId),
  zoneSecsetSave: (input) => ipcRenderer.invoke(CHANNELS.zoneSecsetSave, input),
  zoneSpeedGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneSpeedGet, zoneId),
  zoneSpeedSave: (input) => ipcRenderer.invoke(CHANNELS.zoneSpeedSave, input),
  zoneCachingGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneCachingGet, zoneId),
  zoneCachingSave: (input) => ipcRenderer.invoke(CHANNELS.zoneCachingSave, input),
  zoneWwwGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneWwwGet, zoneId),
  zoneWwwSave: (input) => ipcRenderer.invoke(CHANNELS.zoneWwwSave, input),
  zoneSslGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneSslGet, zoneId),
  zoneSslSave: (input) => ipcRenderer.invoke(CHANNELS.zoneSslSave, input),
  zoneMailGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneMailGet, zoneId),
  zoneMailSave: (input) => ipcRenderer.invoke(CHANNELS.zoneMailSave, input),
  zoneMailDelete: (input) => ipcRenderer.invoke(CHANNELS.zoneMailDelete, input),
  zoneHeadersGet: (zoneId) => ipcRenderer.invoke(CHANNELS.zoneHeadersGet, zoneId),
  zoneHeadersSave: (input) => ipcRenderer.invoke(CHANNELS.zoneHeadersSave, input),
  logsQuery: (input) => ipcRenderer.invoke(CHANNELS.logsQuery, input),
  parentLinks: () => ipcRenderer.invoke(CHANNELS.parentLinks),
  parentPreview: (input) => ipcRenderer.invoke(CHANNELS.parentPreview, input),
  parentApply: (input) => ipcRenderer.invoke(CHANNELS.parentApply, input),
  parentRemove: (input) => ipcRenderer.invoke(CHANNELS.parentRemove, input),
  onAuthChanged: (listener) => {
    const handler = (_event: unknown, state: AuthState): void => listener({ signedIn: state.signedIn, notice: state.notice })
    ipcRenderer.on(CHANNELS.authChanged, handler)
    return () => void ipcRenderer.removeListener(CHANNELS.authChanged, handler)
  },
  onSyncProgress: (listener) => {
    const handler = (_event: unknown, p: SyncProgressView): void => listener({ phase: p.phase, profileId: String(p.profileId), done: Number(p.done), total: Number(p.total) })
    ipcRenderer.on(CHANNELS.syncProgress, handler)
    return () => void ipcRenderer.removeListener(CHANNELS.syncProgress, handler)
  },
  cloudStatus: () => ipcRenderer.invoke(CHANNELS.cloudStatus),
  cloudAccounts: () => ipcRenderer.invoke(CHANNELS.cloudAccounts),
  cloudEnable: (accountId, use) => ipcRenderer.invoke(CHANNELS.cloudEnable, accountId, use),
  cloudDisable: () => ipcRenderer.invoke(CHANNELS.cloudDisable),
  cloudResolve: (use) => ipcRenderer.invoke(CHANNELS.cloudResolve, use),
  onCloudChanged: (listener) => {
    const handler = (_event: unknown, s: CloudStatus): void => listener({ ...s })
    ipcRenderer.on(CHANNELS.cloudChanged, handler)
    return () => void ipcRenderer.removeListener(CHANNELS.cloudChanged, handler)
  },
  onDataChanged: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(CHANNELS.dataChanged, handler)
    return () => void ipcRenderer.removeListener(CHANNELS.dataChanged, handler)
  }
}
contextBridge.exposeInMainWorld('zonekeeper', api)
