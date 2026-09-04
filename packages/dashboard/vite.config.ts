import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

function detectMockMateHttpPort(): number {
  const envPort = process.env.MOCKMATE_HTTP_PORT ? parseInt(process.env.MOCKMATE_HTTP_PORT, 10) : NaN
  if (Number.isFinite(envPort) && envPort > 0) return envPort

  // Try reading user config (useful for local dev)
  try {
    const configPath = path.join(os.homedir(), '.mockmate', 'config.json')
    const raw = fs.readFileSync(configPath, 'utf8')
    const cfg = JSON.parse(raw)
    const p = cfg?.server?.httpPort
    if (typeof p === 'number' && p > 0) return p
  } catch {
    // ignore
  }

  return 3456
}

// https://vite.dev/config/
export default defineConfig({
  // The workspace resolves this plugin through root Vite 5, while defineConfig uses dashboard Vite 7.
  // Remove the bridge once both packages resolve the same Vite major and PluginOption identity.
  plugins: [react() as unknown as import('vite').PluginOption],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${detectMockMateHttpPort()}`,
        changeOrigin: true,
      },
    },
  },
})
