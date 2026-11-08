import { contextBridge, ipcRenderer } from 'electron'
import { APP_CHANNELS, type AppApi } from '../shared/tools'

export function exposeAppApi(): void {
  const api: AppApi = { openTool: (tool) => ipcRenderer.invoke(APP_CHANNELS.openTool, tool) }
  contextBridge.exposeInMainWorld('zonekit', api)
}
