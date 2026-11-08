import { ipcMain } from 'electron'
import { createGuard, isTrustedEvent } from '@app/main/ipcGuard'
import { PAGES } from '@app/shared/tools'
import { CHANNELS } from '../shared/ipc'
import { dnsLookup } from './dnsLookup'
import { findSubdomains } from './subdomains'
import { testTls } from './tlsTest'
import { testEmail } from './emailTest'
import { explainRecord } from './explain'
import { runTestssl, testsslStatus } from './testssl'

export function registerZonetester(devOrigin?: string): void {
  const guard = createGuard(devOrigin, PAGES.zonetester)
  ipcMain.handle(CHANNELS.dnsLookup, guard((raw: unknown) => dnsLookup(raw)))
  ipcMain.handle(CHANNELS.findSubdomains, guard((raw: unknown) => findSubdomains(raw)))
  ipcMain.handle(CHANNELS.testTls, guard((raw: unknown) => testTls(raw)))
  ipcMain.handle(CHANNELS.testEmail, guard((raw: unknown) => testEmail(raw)))
  ipcMain.handle(CHANNELS.explainRecord, guard((raw: unknown) => explainRecord(raw)))
  // Needs the sender to stream output back
  ipcMain.handle(CHANNELS.runTestssl, (event, raw: unknown) => {
    if (!isTrustedEvent(event, devOrigin, PAGES.zonetester)) throw new Error('Untrusted sender')
    return runTestssl(raw, (line) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.testsslOutput, line)
    })
  })
  ipcMain.handle(CHANNELS.testsslStatus, guard(() => testsslStatus()))
}
