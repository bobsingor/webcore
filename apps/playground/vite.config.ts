import { webcorePreview } from '@webcore/kernel/vite'
import { defineConfig } from 'vite'

// SharedArrayBuffer requires cross-origin isolation (ADR-0002). Previews are embedded from
// p<port>.localhost origins (ADR-0014), which serve with their own headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [webcorePreview()],
  server: { port: 5180, headers: isolation },
  preview: { port: 5180, headers: isolation },
  worker: { format: 'es' },
  build: { target: 'es2023' },
})
