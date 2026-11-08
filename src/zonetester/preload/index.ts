import { contextBridge, ipcRenderer } from 'electron'
import { exposeAppApi } from '@app/preload/appApi'
import { CHANNELS, type ZonetesterApi } from '../shared/ipc'

exposeAppApi()

const api: ZonetesterApi = {
  dnsLookup: (input) => ipcRenderer.invoke(CHANNELS.dnsLookup, input),
  findSubdomains: (input) => ipcRenderer.invoke(CHANNELS.findSubdomains, input),
  testTls: (input) => ipcRenderer.invoke(CHANNELS.testTls, input),
  testEmail: (input) => ipcRenderer.invoke(CHANNELS.testEmail, input),
  explainRecord: (input) => ipcRenderer.invoke(CHANNELS.explainRecord, input),
  runTestssl: (input) => ipcRenderer.invoke(CHANNELS.runTestssl, input),
  testsslStatus: () => ipcRenderer.invoke(CHANNELS.testsslStatus),
  onTestsslOutput: (listener) => {
    const handler = (_event: unknown, line: unknown): void => listener(String(line))
    ipcRenderer.on(CHANNELS.testsslOutput, handler)
    return () => void ipcRenderer.removeListener(CHANNELS.testsslOutput, handler)
  }
}
contextBridge.exposeInMainWorld('zonetester', api)
