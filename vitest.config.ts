import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  resolve: { alias: { '@app': resolve(__dirname, 'src/app') } }
})
