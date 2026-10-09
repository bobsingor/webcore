// The runtime page (ADR-0009, ADR-0017). It runs on its own origin, cross-origin isolated by its
// own headers, inside an iframe that @webcore/sdk creates. The embedding page never touches the
// kernel: it gets one MessagePort, and this page answers on it.
import { busyboxLinks, installRootfs, Kernel, PreviewBridge } from '@webcore/kernel'
import { webProcessHost } from '@webcore/kernel/web'
import nodeLibUrl from '@webcore/node-lib/node-lib.bin?url'
import { previewOrigin, PROTOCOL_VERSION, RUNTIME_HELLO, RUNTIME_LOADED, type RuntimeHello } from '@webcore/sdk/protocol'
import userland from '@webcore/userland/userland.json'
import busyboxLinksText from '@webcore/wasix-bin/busybox.links?raw'
import busyboxUrl from '@webcore/wasix-bin/busybox.wasm?url'
import { serveRuntime } from './server.ts'
import { openWorkspace } from './storage.ts'

const NOT_ISOLATED =
  "The webcore runtime isn't cross-origin isolated, so it can't use SharedArrayBuffer. Its page must be " +
  'served with Document-Isolation-Policy (Chromium), or, in other browsers, be embedded by a page that is ' +
  'itself cross-origin isolated (Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: ' +
  'require-corp or credentialless). See ADR-0017.'

// Previews are served from p<port>.localhost on this runtime's port (ADR-0014). A deployment on
// its own domain would use p{port}.<preview domain>.
const PREVIEW_ORIGIN = `${location.protocol}//p{port}.localhost${location.port ? `:${location.port}` : ''}`

const download = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer())
const loadAssets = () => Promise.all([download(nodeLibUrl), download(busyboxUrl)])

async function start(port: MessagePort, hello: RuntimeHello, assets: ReturnType<typeof loadAssets>): Promise<void> {
  if (!crossOriginIsolated) {
    port.postMessage({ t: 'failed', message: NOT_ISOLATED })
    return
  }
  try {
    const [nodeLib, busybox] = await assets
    const kernel = new Kernel({ host: webProcessHost(), assets: { 'node-lib': nodeLib } })
    installRootfs(kernel, { busybox: { binary: busybox, links: busyboxLinks(busyboxLinksText) }, userland })
    // /home comes back from the workspace's saved state, and is saved as it changes (M2b).
    const workspace = hello.workspace === null ? undefined : await openWorkspace(kernel, hello.workspace || 'default', hello.from)
    const bridge = new PreviewBridge(kernel, { origin: (number) => previewOrigin(PREVIEW_ORIGIN, number) })
    serveRuntime(kernel, port, { previewOrigin: PREVIEW_ORIGIN, previews: bridge, workspace })
  } catch (error) {
    port.postMessage({ t: 'failed', message: `The webcore runtime failed to start: ${error instanceof Error ? error.message : String(error)}` })
  }
}

if (window.parent === window) {
  document.getElementById('status')!.textContent = 'This is the webcore runtime. Pages embed it with @webcore/sdk.'
} else {
  // Downloads start right away, while the embedding page sets up the channel.
  const assets = loadAssets()
  assets.catch(() => {})
  // One embedding page drives this runtime: the parent, once.
  let connected = false
  addEventListener('message', (event) => {
    if (connected || event.source !== window.parent || event.data?.type !== RUNTIME_HELLO || !event.ports[0]) return
    connected = true
    void start(event.ports[0], event.data as RuntimeHello, assets)
  })
  window.parent.postMessage({ type: RUNTIME_LOADED, protocol: PROTOCOL_VERSION }, '*')
}
