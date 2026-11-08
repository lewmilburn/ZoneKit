import { join } from 'node:path'
import type { BrowserWindowConstructorOptions, WebContents } from 'electron'

// Type-only Electron imports, so tests can load this.
export function windowOptions(opts: { preload: string; title: string; width?: number; height?: number; resizable?: boolean }): BrowserWindowConstructorOptions {
  return {
    width: opts.width ?? 1100,
    height: opts.height ?? 760,
    minWidth: Math.min(opts.width ?? 800, 800),
    minHeight: Math.min(opts.height ?? 560, 560),
    resizable: opts.resizable ?? true,
    show: false,
    title: opts.title,
    webPreferences: {
      preload: join(__dirname, `../preload/${opts.preload}.js`),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
}

/** Fails closed. */
export function isAllowedNavigation(url: string, allowedOrigin?: string): boolean {
  if (!allowedOrigin) return false
  try {
    return new URL(url).origin === allowedOrigin
  } catch {
    return false
  }
}

export function lockDown(contents: WebContents, allowedOrigin?: string): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, allowedOrigin)) event.preventDefault()
  })
  contents.on('will-redirect', (event) => event.preventDefault())
  contents.on('will-attach-webview', (event) => event.preventDefault())
}
