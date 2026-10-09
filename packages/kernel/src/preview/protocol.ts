// Messages between preview pages (and their Service Worker) and the PreviewBridge (ADR-0014).
// They travel over a MessagePort that a preview page obtains by posting `{ type: 'webcore:connect' }`
// with a transferred port to the embedding window.

export interface FetchMessage {
  type: 'fetch'
  id: number
  /** The kernel port: from the preview origin's `p<port>` hostname label. */
  port: number
  method: string
  /** Path and query. */
  url: string
  /** The Host header to send: the preview origin's host, so absolute URLs the server builds work. */
  host: string
  headers: [string, string][]
  body?: ArrayBuffer
  /** A navigation: HTML responses get the preview client script injected. */
  navigate: boolean
}

export type PreviewRequest =
  | FetchMessage
  | { type: 'abort'; id: number }
  | { type: 'ws-open'; id: number; port: number; url: string; host: string; protocols: string[]; origin: string }
  | { type: 'ws-send'; id: number; data: string | ArrayBuffer }
  | { type: 'ws-close'; id: number; code?: number; reason?: string }

export type PreviewReply =
  | { type: 'head'; id: number; status: number; statusText: string; headers: [string, string][] }
  | { type: 'chunk'; id: number; data: Uint8Array }
  | { type: 'end'; id: number }
  | { type: 'error'; id: number; message: string }
  | { type: 'ws-open'; id: number; protocol: string; extensions: string }
  | { type: 'ws-message'; id: number; data: string | ArrayBuffer }
  | { type: 'ws-close'; id: number; code: number; reason: string; wasClean: boolean }

/** The script injected into every HTML page a preview navigates to. */
export const CLIENT_SCRIPT_PATH = '/__webcore/client.js'
/** The page that installs the Service Worker and connects it to the bridge. */
export const BOOT_PAGE_PATH = '/__webcore/boot.html'
/** The Service Worker (at the root, so its scope can be the whole origin). */
export const SERVICE_WORKER_PATH = '/__webcore_sw.js'

/** The kernel port a preview hostname stands for: `p3000.localhost` → 3000. */
export function previewPortOf(hostname: string): number | undefined {
  const match = /^p(\d{1,5})(?:[.-]|$)/.exec(hostname)
  const port = match ? Number(match[1]) : NaN
  return port > 0 && port < 65536 ? port : undefined
}
