// @webcore/sdk: embeds webcore in a page (ADR-0009, ADR-0017). connect() starts the runtime in an
// iframe on the runtime's own origin and returns a Runtime: files, processes, shell sessions,
// kernel events and previews, all as async calls over one MessagePort. Code running in webcore
// never shares an origin, or a process, with the embedding page.
import { openRuntime, Runtime, RuntimeError } from './client.ts'
import { PROTOCOL_VERSION, RUNTIME_HELLO, RUNTIME_LOADED } from './protocol.ts'

export { openRuntime, Runtime, RuntimeError } from './client.ts'
export type {
  ExecOptions,
  ExecResult,
  OutputHandlers,
  RuntimeEvents,
  RuntimeFs,
  RuntimeProcess,
  RuntimeTerminal,
  ShellSession,
  SpawnOptions,
  TerminalOptions,
} from './client.ts'
export type { DirEntry, FileStat, FileType, FsOp, RuntimeEvent, RuntimeInfo, ShellState } from './protocol.ts'

export interface ConnectOptions {
  /** The runtime page (@webcore/runtime), served with the headers ADR-0017 lists. */
  url: string | URL
  /** Where the invisible runtime frame goes. Default: document.body. */
  container?: HTMLElement
  /** How long to wait for the runtime to load and boot, in milliseconds. Default: 30 s. */
  timeout?: number
}

/** Starts a runtime and connects to it. Each call gets its own runtime, with its own kernel. */
export async function connect(options: ConnectOptions): Promise<Runtime> {
  const url = new URL(options.url, location.href)
  const timeout = options.timeout ?? 30_000
  const frame = document.createElement('iframe')
  frame.src = url.href
  frame.title = 'webcore runtime'
  // In browsers without Document-Isolation-Policy, the runtime can only be cross-origin isolated
  // by inheriting it from an embedding page that is, and only if the frame is allowed to.
  frame.allow = 'cross-origin-isolated'
  frame.tabIndex = -1
  frame.setAttribute('aria-hidden', 'true')
  Object.assign(frame.style, { position: 'fixed', width: '0', height: '0', border: '0', opacity: '0', pointerEvents: 'none' })

  // The runtime announces itself once it listens; only then does it get the port.
  const loaded = new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== url.origin || event.data?.type !== RUNTIME_LOADED) return
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new RuntimeError(`The webcore runtime at ${url.origin} didn't load within ${timeout} ms`))
    }, timeout)
    function cleanup() {
      clearTimeout(timer)
      removeEventListener('message', onMessage)
    }
    addEventListener('message', onMessage)
  })
  ;(options.container ?? document.body).append(frame)

  let runtime: Runtime
  // Preview pages ask their parent, this window, for a channel to the bridge. They are untrusted:
  // their ports are passed on to the runtime, which serves them, and nothing else is read from them.
  const relay = (event: MessageEvent) => {
    if (event.data?.type === 'webcore:connect' && event.ports[0]) runtime.connectPreview(event.origin, event.ports[0])
  }
  try {
    await loaded
    const { port1, port2 } = new MessageChannel()
    const opening = openRuntime(port1, {
      timeout,
      onClose: () => {
        removeEventListener('message', relay)
        frame.remove()
      },
    })
    frame.contentWindow!.postMessage({ type: RUNTIME_HELLO, protocol: PROTOCOL_VERSION }, url.origin, [port2])
    runtime = await opening
  } catch (error) {
    frame.remove()
    throw error
  }
  addEventListener('message', relay)
  return runtime
}
