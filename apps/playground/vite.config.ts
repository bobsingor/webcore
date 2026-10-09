import { defineConfig } from 'vite'

// SharedArrayBuffer requires cross-origin isolation (ADR-0002).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  server: { port: 5180, headers: isolation },
  preview: { port: 5180, headers: isolation },
  worker: { format: 'es' },
  build: { target: 'es2023' },
})
