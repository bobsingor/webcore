// webcore preview Service Worker (ADR-0014). Installed on a preview origin (p<port>.<host>), it
// forwards every same-origin request over a MessagePort to the PreviewBridge in the embedding page,
// which answers from the server listening on <port> inside the kernel.
//
// The worker can be stopped whenever it is idle, which loses the port. Pages on this origin hand it
// a new one on request ('webcore:need-channel'); a navigation with no page left to ask gets the
// boot page, which reconnects and reloads.

const PORT = Number(/^p(\d{1,5})(?:[.-]|$)/.exec(self.location.hostname)?.[1])
const CHANNEL_TIMEOUT = 3000
const PASSTHROUGH = /^\/(__webcore\/|__webcore_sw\.js$)/
const NULL_BODY = new Set([101, 103, 204, 205, 304])

let channel = null
let nextId = 1
const waiting = []
const pending = new Map()

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'webcore:channel' || !event.ports[0]) return
  setChannel(event.ports[0])
  event.source?.postMessage({ type: 'webcore:channel-ready' })
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || PASSTHROUGH.test(url.pathname)) return
  event.respondWith(handle(event.request, url))
})

function setChannel(port) {
  channel = port
  port.onmessage = (event) => onReply(event.data)
  for (const resolve of waiting.splice(0)) resolve(port)
}

async function getChannel() {
  if (channel) return channel
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (!clients.length) return null
  for (const client of clients) client.postMessage({ type: 'webcore:need-channel' })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = waiting.indexOf(done)
      if (index >= 0) waiting.splice(index, 1)
      resolve(null)
    }, CHANNEL_TIMEOUT)
    const done = (port) => {
      clearTimeout(timer)
      resolve(port)
    }
    waiting.push(done)
  })
}

// Responses must be embeddable by the cross-origin-isolated page that hosts the preview.
function responseHeaders(pairs) {
  const headers = new Headers()
  for (const [name, value] of pairs) {
    try {
      headers.append(name, value)
    } catch {
      // A header the browser won't accept; drop it.
    }
  }
  if (!headers.has('cross-origin-embedder-policy')) headers.set('Cross-Origin-Embedder-Policy', 'credentialless')
  if (!headers.has('cross-origin-resource-policy')) headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  return headers
}

async function handle(request, url) {
  const navigate = request.mode === 'navigate'
  const port = await getChannel()
  if (!port) {
    if (navigate) return fetch('/__webcore/boot.html')
    return new Response('webcore preview is disconnected', { status: 503 })
  }

  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
  const id = nextId++
  return new Promise((resolve) => {
    let controller
    let started = false
    const stream = new ReadableStream({
      start(c) {
        controller = c
      },
      cancel() {
        pending.delete(id)
        port.postMessage({ type: 'abort', id })
      },
    })
    request.signal?.addEventListener('abort', () => {
      if (!pending.has(id)) return
      pending.delete(id)
      port.postMessage({ type: 'abort', id })
      if (started) controller.error(new DOMException('aborted', 'AbortError'))
      else resolve(Response.error())
    })
    pending.set(id, {
      head(message) {
        started = true
        const nullBody = NULL_BODY.has(message.status) || request.method === 'HEAD'
        const init = { status: message.status, statusText: message.statusText, headers: responseHeaders(message.headers) }
        try {
          resolve(new Response(nullBody ? null : stream, init))
        } catch (error) {
          // A status the Response constructor rejects (e.g. 101).
          resolve(new Response(String(error), { status: 502 }))
        }
      },
      chunk(message) {
        controller.enqueue(message.data)
      },
      end() {
        pending.delete(id)
        controller.close()
      },
      error(message) {
        pending.delete(id)
        if (started) controller.error(new Error(message.message))
        else resolve(new Response(message.message, { status: 502, headers: responseHeaders([]) }))
      },
    })
    port.postMessage(
      {
        type: 'fetch',
        id,
        port: PORT,
        method: request.method,
        url: url.pathname + url.search,
        host: url.host,
        headers: [...request.headers],
        body,
        navigate,
      },
      body ? [body] : [],
    )
  })
}

function onReply(message) {
  const entry = pending.get(message?.id)
  if (!entry) return
  switch (message.type) {
    case 'head':
      entry.head(message)
      break
    case 'chunk':
      entry.chunk(message)
      break
    case 'end':
      entry.end()
      break
    case 'error':
      entry.error(message)
      break
  }
}
