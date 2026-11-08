import { setupServices } from './wiring'

export function registerZonekeeper(devOrigin?: string): void {
  setupServices(devOrigin)
}
