import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')
const renderer = resolve(__dirname, 'src/renderer/src')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@shared': shared, '@renderer': renderer } },
    server: { port: Number(process.env.PORT) || 5174 },
    define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '') },
    build: {
      // Monaco's editor core is inherently large and loads from local disk in the
      // packaged app, so the network-oriented size warning is noise here.
      // Its manual chunk is added in Phase 2, when an editor is actually mounted.
      chunkSizeWarningLimit: 9000
    }
  }
})
