import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import preact from '@preact/preset-vite'
import { cspFor } from './src/app/shared/csp'

/** Code shared by every part of ZoneKit lives in src/app and is imported as @app/... */
const appAlias = { '@app': resolve(__dirname, 'src/app') }

function csp(): Plugin {
  let dev = false
  return {
    name: 'zonekit-csp',
    configResolved(c) {
      dev = c.command === 'serve'
    },
    transformIndexHtml: {
      order: 'pre',
      handler: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: cspFor(dev) },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: appAlias },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/app/main/index.ts') } } }
  },
  // One preload per window, so each page only gets its own tool's API. Sandboxed preloads can't
  // load other files, so each is built as one self-contained file with no shared chunks.
  preload: {
    resolve: { alias: appAlias },
    build: {
      isolatedEntries: true,
      rollupOptions: {
        input: {
          launcher: resolve(__dirname, 'src/app/preload/launcher.ts'),
          zonekeeper: resolve(__dirname, 'src/zonekeeper/preload/index.ts'),
          zonetester: resolve(__dirname, 'src/zonetester/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    build: {
      // Inlined data: URIs would be blocked by default-src 'self'.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          launcher: resolve(__dirname, 'src/app/renderer/index.html'),
          zonekeeper: resolve(__dirname, 'src/zonekeeper/renderer/index.html'),
          zonetester: resolve(__dirname, 'src/zonetester/renderer/index.html')
        }
      }
    },
    resolve: { alias: appAlias },
    plugins: [preact(), csp()]
  }
})
