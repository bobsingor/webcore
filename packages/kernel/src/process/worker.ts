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
        self.addEventListener('unhandledrejection', (rejection) => {
          rejection.preventDefault()
          handler(rejection.reason)
        })
      },
    }),
  { once: true },
)
