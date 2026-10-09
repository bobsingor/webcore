// wasi (src/node_wasi.cc): node:wasi's WASI class, on the same preview1 implementation as the WASI
// personality, with its own fd table. Rolldown's wasm32-wasi build runs through this.
import { createPreview1 } from '../../wasi/preview1.ts'
import type { Realm } from '../realm.ts'

export function wasiBindings() {
  return {
    wasi: (realm: Realm) => {
      class WASI {
        // Everything is an own, enumerable property: lib/wasi.js binds each one with for…in, and
        // passes the object to WebAssembly as the import namespace.
        [name: string]: unknown

        constructor(args: string[], env: string[], preopens: string[], stdio: [number, number, number]) {
          let memory: WebAssembly.Memory | undefined
          const pairs: [string, string][] = []
          for (let i = 0; i < preopens.length; i += 2) pairs.push([preopens[i], preopens[i + 1]])
          const wasi = createPreview1({
            sys: realm.sys,
            args,
            env,
            preopens: pairs,
            stdio,
            ownsStdio: false,
            memory: () => {
              if (!memory) throw new Error('WASI memory has not been set (call wasi.start() or wasi.initialize())')
              return memory
            },
            exit: (code) => realm.loop.reallyExit(code),
          })
          Object.assign(this, wasi.imports)
          this._setMemory = (value: WebAssembly.Memory) => {
            memory = value
          }
        }
      }
      return { WASI }
    },
  }
}
