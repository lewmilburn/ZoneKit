/// <reference types="vite/client" />
import type { ZonetesterApi } from '../shared/ipc'
import '@app/renderer/env'

declare global {
  interface Window {
    zonetester: ZonetesterApi
  }
}
