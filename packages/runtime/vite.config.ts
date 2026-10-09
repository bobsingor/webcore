import { webcorePreview } from '@webcore/kernel/vite'
import { defineConfig, type Connect, type Plugin } from 'vite'

// The runtime runs untrusted code on its own origin (ADR-0009). Its documents and workers isolate
// themselves with Document-Isolation-Policy (Chromium). COEP and CORP let it inherit isolation
// instead from an isolated embedding page, in browsers without that header (ADR-0017).
const ISOLATION = {
  'Document-Isolation-Policy': 'isolate-and-require-corp',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

// Preview origins (p<port>.<host>) get the preview plugin's headers instead (ADR-0014).
const PREVIEW_HOST = /^p\d{1,5}(?:[.-]|$)/

function isolation(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (!PREVIEW_HOST.test(hostname)) for (const [name, value] of Object.entries(ISOLATION)) res.setHeader(name, value)
    next()
  }
  return {
    name: 'webcore-runtime-isolation',
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  }
}

export default defineConfig({
  plugins: [isolation(), webcorePreview()],
  server: { port: 5190, strictPort: true },
  preview: { port: 5190, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2023' },
})
