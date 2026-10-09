// Process Worker entry for browsers.
import type { BootMessage } from '../abi/protocol.ts'
import { startProcess } from './main.ts'

// Captured now: the Node realm hides browser-only globals such as `self` and `addEventListener`.
const on = self.addEventListener.bind(self)

on(
  'message',
  (event) =>
    startProcess((event as MessageEvent).data as BootMessage, {
      onUncaughtError(handler) {
        on('error', (error) => {
          error.preventDefault()
          handler(error.error ?? new Error(error.message))
        })
      },
      onUnhandledRejection(handler) {
        on('unhandledrejection', (event) => {
          event.preventDefault()
          handler(event.reason, event.promise)
        })
      },
      onRejectionHandled(handler) {
        on('rejectionhandled', (event) => handler(event.promise))
      },
    }),
  { once: true },
)
