import { defineConfig } from 'vite'

// The playground embeds webcore through @webcore/sdk; the kernel runs in the runtime's own origin
// (ADR-0017), so this page needs no isolation headers. Browsers without Document-Isolation-Policy
// need an isolated embedder instead: set WEBCORE_ISOLATE=1.
const isolation = process.env.WEBCORE_ISOLATE
  ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
  : {}

export default defineConfig({
  server: { port: 5180, headers: isolation },
  preview: { port: 5180, headers: isolation },
  build: { target: 'es2023' },
})
