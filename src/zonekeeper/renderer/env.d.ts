/// <reference types="vite/client" />
import type { ZonekeeperApi } from '../shared/ipc'
import '@app/renderer/env'

declare global {
  interface Window {
    zonekeeper: ZonekeeperApi
  }
}
