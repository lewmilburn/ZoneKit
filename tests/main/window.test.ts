import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { isAllowedNavigation, lockDown, windowOptions } from '../../src/app/main/window'
import { PROD_CSP, cspFor } from '../../src/app/shared/csp'

describe('windowOptions', () => {
  it('hardens the renderer', () => {
    const prefs = windowOptions({ preload: 'zonekeeper', title: 'ZoneKeeper' }).webPreferences
    expect(prefs?.contextIsolation).toBe(true)
    expect(prefs?.nodeIntegration).toBe(false)
    expect(prefs?.sandbox).toBe(true)
  })

  it('points each window at its own preload, matching the build output names', () => {
    for (const name of ['launcher', 'zonekeeper', 'zonetester']) {
      const preload = windowOptions({ preload: name, title: name }).webPreferences?.preload ?? ''
      expect(preload.endsWith(`${sep}preload${sep}${name}.js`)).toBe(true)
    }
  })
})

describe('isAllowedNavigation', () => {
  it('allows only the given origin', () => {
    expect(isAllowedNavigation('http://localhost:5173/x', 'http://localhost:5173')).toBe(true)
    expect(isAllowedNavigation('https://evil.example/', 'http://localhost:5173')).toBe(false)
  })
  it('blocks everything with no allowed origin (production)', () => {
    expect(isAllowedNavigation('file:///app/index.html')).toBe(false)
  })
  it('fails closed on malformed URLs', () => {
    expect(isAllowedNavigation('not a url', 'http://localhost:5173')).toBe(false)
    expect(isAllowedNavigation('', 'http://localhost:5173')).toBe(false)
  })
})

function fakeContents() {
  const handlers: Record<string, (...a: any[]) => void> = {}
  let openHandler: (() => { action: string }) | undefined
  const contents = {
    setWindowOpenHandler: (h: () => { action: string }) => {
      openHandler = h
    },
    on: (name: string, h: (...a: any[]) => void) => {
      handlers[name] = h
    }
  }
  return { contents: contents as unknown as WebContents, handlers, open: () => openHandler?.() }
}

describe('lockDown', () => {
  it('denies new windows', () => {
    const f = fakeContents()
    lockDown(f.contents)
    expect(f.open()).toEqual({ action: 'deny' })
  })

  it('prevents navigation to other origins and malformed URLs, allows the dev origin', () => {
    const f = fakeContents()
    lockDown(f.contents, 'http://localhost:5173')
    const run = (url: string) => {
      const event = { preventDefault: vi.fn() }
      f.handlers['will-navigate'](event, url)
      return event.preventDefault.mock.calls.length > 0
    }
    expect(run('https://evil.example/')).toBe(true)
    expect(run('::bad::')).toBe(true)
    expect(run('http://localhost:5173/')).toBe(false)
  })

  it('prevents redirects and webview attachment', () => {
    const f = fakeContents()
    lockDown(f.contents)
    for (const name of ['will-redirect', 'will-attach-webview']) {
      const event = { preventDefault: vi.fn() }
      f.handlers[name](event)
      expect(event.preventDefault).toHaveBeenCalled()
    }
  })
})

describe('CSP', () => {
  it('production policy is exactly default-src self', () => {
    expect(cspFor(false)).toBe("default-src 'self'")
    expect(PROD_CSP).toBe("default-src 'self'")
  })

  const built = resolve(__dirname, '../../out/renderer/index.html')
  it.skipIf(!existsSync(built))('built renderer HTML carries exactly the production policy', () => {
    const html = readFileSync(built, 'utf8')
    const metas = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/g)]
    expect(metas).toHaveLength(1)
    expect(metas[0][1].replaceAll('&#39;', "'")).toBe(PROD_CSP)
  })
})
