// The host's own primitives, captured when this module loads, before Node's bootstrap replaces
// the globals. Node installs its own URL, TextEncoder, performance, queueMicrotask, atob, … and
// those call back into our bindings: a binding that used the global at call time would recurse.
// Bindings must use these instead of the globals.
const g = globalThis

export const host = {
  TextEncoder: g.TextEncoder,
  TextDecoder: g.TextDecoder,
  URL: g.URL,
  MessageChannel: g.MessageChannel,
  performance: g.performance,
  navigator: g.navigator as Navigator | undefined,
  atob: g.atob.bind(g),
  btoa: g.btoa.bind(g),
  structuredClone: g.structuredClone.bind(g),
  queueMicrotask: g.queueMicrotask.bind(g),
  setTimeout: g.setTimeout.bind(g),
  clearTimeout: g.clearTimeout.bind(g),
}
