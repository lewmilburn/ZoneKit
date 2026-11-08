/// <reference types="vite/client" />
import type { AppApi } from '../shared/tools'

declare global {
  interface Window {
    zonekit: AppApi
  }
}
