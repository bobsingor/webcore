// A Vite plugin for pages that host webcore previews (ADR-0014). It serves the preview assets in
// dev and `vite preview`, and emits them into builds. Plain JavaScript, so Vite configs can load it
// without a TypeScript-aware loader.
//
// On preview origins (p<port>.<host>), the server provides nothing but these assets: any page
// request gets the boot page, which installs the Service Worker that answers everything else from
// the kernel. A static deployment needs the same fallback for preview hosts.
import { readFileSync } from 'node:fs'

const ASSETS = {
  '/__webcore_sw.js': ['sw.js', 'text/javascript'],
  '/__webcore/client.js': ['client.js', 'text/javascript'],
  '/__webcore/boot.html': ['boot.html', 'text/html'],
}

// Preview documents may be embedded by a cross-origin-isolated page (ADR-0017).
const HEADERS = {
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': 'no-cache',
}

// Same rule as previewPortOf() in protocol.ts.
const PREVIEW_HOST = /^p(\d{1,5})(?:[.-]|$)/

const read = (file) => readFileSync(new URL(`./assets/${file}`, import.meta.url))

function send(res, status, type, body) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': `${type}; charset=utf-8` })
  res.end(body)
}

/** @returns {import('./vite.d.ts').WebcorePreviewPlugin} */
export function webcorePreview() {
  const middleware = (req, res, next) => {
    const path = (req.url ?? '/').split('?')[0]
    const asset = ASSETS[path]
    if (asset) return send(res, 200, asset[1], read(asset[0]))

    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (!PREVIEW_HOST.test(hostname)) return next()
    const destination = req.headers['sec-fetch-dest']
    const page = destination === 'document' || destination === 'iframe' || /text\/html/.test(req.headers.accept ?? '')
    if (page) send(res, 200, 'text/html', read('boot.html'))
    else send(res, 404, 'text/plain', 'Not found')
  }

  return {
    name: 'webcore-preview',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
    generateBundle() {
      for (const [path, [file]] of Object.entries(ASSETS)) {
        this.emitFile({ type: 'asset', fileName: path.slice(1), source: read(file) })
      }
    },
  }
}
