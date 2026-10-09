import type { IncomingMessage, ServerResponse } from 'node:http'

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

interface ConnectServer {
  middlewares: { use(middleware: Middleware): void }
}

/** Structurally a Vite plugin; typed without depending on Vite. */
export interface WebcorePreviewPlugin {
  name: 'webcore-preview'
  configureServer(server: ConnectServer): void
  configurePreviewServer(server: ConnectServer): void
  generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: Uint8Array }): string }): void
}

/** Serves the preview Service Worker, client script and boot page (ADR-0014). */
export function webcorePreview(): WebcorePreviewPlugin
