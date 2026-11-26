import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// The unit tests import main-process modules directly, so they need the same
// `@shared` alias electron-vite injects at build time.
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
