// webcore preview client (ADR-0014), injected as the first script of every HTML page in a preview.
//  - Connects the preview's Service Worker to the bridge in the embedding page when it asks.
//  - Reports navigations to the embedding page (`webcore:location`), for its address bar.
//  - Replaces WebSocket for URLs that point into the kernel: the bridge opens the connection to the
//    server there and relays frames, because Service Workers can't intercept WebSockets.
;(() => {
  if (window.__webcore) return

  const embedder = window.parent !== window ? window.parent : null
  const sw = navigator.serviceWorker
  const PREVIEW_PORT = Number(/^p(\d{1,5})(?:[.-]|$)/.exec(location.hostname)?.[1])

  /** A new MessagePort connected to the PreviewBridge, or null outside an embedding page. */
  function openChannel() {
    if (!embedder) return null
    const { port1, port2 } = new MessageChannel()
    embedder.postMessage({ type: 'webcore:connect' }, '*', [port1])
    return port2
  }

  /** Gives `worker` a channel to the bridge; resolves true once it confirms. */
  function connectWorker(worker) {
    const port = openChannel()
    if (!port || !worker) return Promise.resolve(false)
    return new Promise((resolve) => {
      const onMessage = (event) => {
        if (event.data?.type !== 'webcore:channel-ready') return
        sw.removeEventListener('message', onMessage)
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        sw.removeEventListener('message', onMessage)
        resolve(false)
      }, 3000)
      sw.addEventListener('message', onMessage)
      worker.postMessage({ type: 'webcore:channel' }, [port])
    })
  }

  sw?.addEventListener('message', (event) => {
    if (event.data?.type === 'webcore:need-channel') void connectWorker(event.source)
  })
  sw?.startMessages?.()

  // Tells the embedding page where the preview is, for its address bar.
  const reportLocation = () => embedder?.postMessage({ type: 'webcore:location', href: location.href }, '*')
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method]
    history[method] = function (...args) {
      const result = original.apply(this, args)
      reportLocation()
      return result
    }
  }
  addEventListener('popstate', reportLocation)
  addEventListener('hashchange', reportLocation)
  if (location.pathname !== '/__webcore/boot.html') reportLocation()

  // --- WebSocket relay ---------------------------------------------------------------------------

  const NativeWebSocket = window.WebSocket
  const sockets = new Map()
  let wsChannel = null
  let nextId = 1

  function channel() {
    if (!wsChannel) {
      wsChannel = openChannel()
      wsChannel.onmessage = (event) => sockets.get(event.data?.id)?._receive(event.data)
    }
    return wsChannel
  }

  /** The kernel port a WebSocket URL points at, or undefined for the real network. */
  function kernelPort(url) {
    if (url.host === location.host) return PREVIEW_PORT
    const host = url.hostname
    const preview = /^p(\d{1,5})\.localhost$/.exec(host)
    if (preview) return Number(preview[1])
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')) {
      return Number(url.port) || (url.protocol === 'wss:' ? 443 : 80)
    }
    return undefined
  }

  const HANDLERS = ['open', 'message', 'error', 'close']

  class WebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    constructor(url, protocols) {
      const resolved = new URL(url, location.href)
      if (resolved.protocol === 'http:') resolved.protocol = 'ws:'
      if (resolved.protocol === 'https:') resolved.protocol = 'wss:'
      const port = kernelPort(resolved)
      if (port === undefined || !embedder) return new NativeWebSocket(url, protocols)
      super()
      this.url = resolved.href
      this.readyState = WebSocket.CONNECTING
      this.protocol = ''
      this.extensions = ''
      this.binaryType = 'blob'
      this.bufferedAmount = 0
      this._id = nextId++
      this._sending = Promise.resolve()
      for (const type of HANDLERS) this[`_on${type}`] = null
      sockets.set(this._id, this)
      channel().postMessage({
        type: 'ws-open',
        id: this._id,
        port,
        url: resolved.pathname + resolved.search,
        host: resolved.host,
        protocols: protocols === undefined ? [] : [].concat(protocols),
        origin: location.origin,
      })
    }

    get CONNECTING() {
      return 0
    }
    get OPEN() {
      return 1
    }
    get CLOSING() {
      return 2
    }
    get CLOSED() {
      return 3
    }

    send(data) {
      if (this.readyState === WebSocket.CONNECTING) throw new DOMException('Still in CONNECTING state.', 'InvalidStateError')
      if (this.readyState !== WebSocket.OPEN) return
      // Blobs are read asynchronously; the queue keeps messages in order.
      this._sending = this._sending.then(async () => {
        let payload = data
        if (data instanceof Blob) payload = await data.arrayBuffer()
        else if (ArrayBuffer.isView(data)) payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        else if (!(data instanceof ArrayBuffer)) payload = String(data)
        channel().postMessage({ type: 'ws-send', id: this._id, data: payload })
      })
    }

    close(code, reason) {
      if (this.readyState >= WebSocket.CLOSING) return
      this.readyState = WebSocket.CLOSING
      void this._sending.then(() => channel().postMessage({ type: 'ws-close', id: this._id, code, reason }))
    }

    _receive(message) {
      switch (message.type) {
        case 'ws-open':
          this.readyState = WebSocket.OPEN
          this.protocol = message.protocol
          this.extensions = message.extensions
          this.dispatchEvent(new Event('open'))
          break
        case 'ws-message': {
          let data = message.data
          if (typeof data !== 'string' && this.binaryType === 'blob') data = new Blob([data])
          this.dispatchEvent(new MessageEvent('message', { data, origin: new URL(this.url).origin }))
          break
        }
        case 'ws-close': {
          const neverOpened = this.readyState === WebSocket.CONNECTING
          this.readyState = WebSocket.CLOSED
          sockets.delete(this._id)
          if (neverOpened || !message.wasClean) this.dispatchEvent(new Event('error'))
          this.dispatchEvent(new CloseEvent('close', { code: message.code, reason: message.reason, wasClean: message.wasClean }))
          break
        }
      }
    }
  }

  // onopen/onmessage/onerror/onclose, as event handler attributes.
  for (const type of HANDLERS) {
    Object.defineProperty(WebSocket.prototype, `on${type}`, {
      get() {
        return this[`_on${type}`]
      },
      set(handler) {
        if (this[`_on${type}`]) this.removeEventListener(type, this[`_on${type}`])
        this[`_on${type}`] = typeof handler === 'function' ? handler : null
        if (this[`_on${type}`]) this.addEventListener(type, this[`_on${type}`])
      },
    })
  }

  window.WebSocket = WebSocket
  window.__webcore = { openChannel, connectWorker }
})()
