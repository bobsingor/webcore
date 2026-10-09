// Registry of internalBinding() implementations. Anything not listed resolves to a tracing stub
// (see trace.ts), and every implemented binding reports accesses to properties it lacks.
import type { Realm } from '../realm.ts'
import { childBindings } from './child.ts'
import { cryptoBindings } from './crypto.ts'
import { encodingBindings } from './encoding.ts'
import { fsBindings } from './fs.ts'
import { httpBindings } from './http.ts'
import { http2Bindings } from './http2.ts'
import { messagingBindings } from './messaging.ts'
import { workerBindings } from './worker.ts'
import { moduleBindings } from './modules.ts'
import { processBindings } from './process.ts'
import { serdesBindings } from './serdes.ts'
import { streamBindings } from './streams.ts'
import { supportBindings } from './support.ts'
import { urlBinding } from './url.ts'
import { wasiBindings } from './wasi.ts'
import { zlibBindings } from './zlib.ts'

export type BindingFactory = (realm: Realm) => object

export function createBindings(): Record<string, BindingFactory> {
  return {
    ...supportBindings(),
    ...processBindings(),
    ...encodingBindings(),
    ...fsBindings(),
    ...moduleBindings(),
    ...childBindings(),
    ...streamBindings(),
    ...httpBindings(),
    ...zlibBindings(),
    ...cryptoBindings(),
    ...wasiBindings(),
    ...messagingBindings(),
    ...workerBindings(),
    ...http2Bindings(),
    ...serdesBindings(),
    url: urlBinding,
  }
}
