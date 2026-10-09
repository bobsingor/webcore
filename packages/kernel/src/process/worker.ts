// Process Worker entry for browsers.
import type { BootMessage } from '../abi/protocol.ts'
import { startProcess } from './main.ts'

self.addEventListener(
  'message',
  (event) =>
    startProcess(event.data as BootMessage, {
      onUncaughtError(handler) {
        self.addEventListener('error', (error) => {
          error.preventDefault()
          handler(error.error ?? new Error(error.message))
        })
      },
      onUnhandledRejection(handler) {
        self.addEventListener('unhandledrejection', (event) => {
          event.preventDefault()
          handler(event.reason, event.promise)
        })
      },
      onRejectionHandled(handler) {
        self.addEventListener('rejectionhandled', (event) => handler(event.promise))
      },
    }),
  { once: true },
)
