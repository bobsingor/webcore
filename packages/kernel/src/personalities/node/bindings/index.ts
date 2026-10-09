// Registry of internalBinding() implementations. Anything not listed resolves to a tracing stub
// (see trace.ts), and every implemented binding reports accesses to properties it lacks.
import type { Realm } from '../realm.ts'
import { childBindings } from './child.ts'
import { encodingBindings } from './encoding.ts'
import { fsBindings } from './fs.ts'
import { moduleBindings } from './modules.ts'
import { processBindings } from './process.ts'
import { streamBindings } from './streams.ts'
import { supportBindings } from './support.ts'
import { urlBinding } from './url.ts'

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
    url: urlBinding,
  }
}
