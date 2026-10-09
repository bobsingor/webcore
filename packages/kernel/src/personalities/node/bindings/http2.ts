// http2 (src/node_http2.cc): Node's http2 module loads (Vite imports it), but there is no nghttp2
// yet, so creating a session throws a coded error.
import { HTTP2_CONSTANTS } from '../data/http2-constants.ts'

const unavailable = () =>
  Object.assign(new TypeError('The feature HTTP/2 is unavailable on the current platform, which is being used to run Node.js'), {
    code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
  })

export function http2Bindings() {
  return {
    http2: () => ({
      constants: { ...HTTP2_CONSTANTS },
      setCallbackFunctions: () => {},
      refreshDefaultSettings: () => {},
      packSettings: () => new Uint8Array(0),
      nghttp2ErrorString: (code: number) => `HTTP/2 error ${code}`,
      optionsBuffer: new Uint32Array(32),
      settingsBuffer: new Uint32Array(32),
      sessionState: new Float64Array(16),
      streamState: new Float64Array(16),
      Http2Session: class Http2Session {
        constructor() {
          throw unavailable()
        }
      },
      Http2Stream: class Http2Stream {},
      Http2Ping: class Http2Ping {},
      Http2Settings: class Http2Settings {},
    }),
    stream_pipe: () => ({
      StreamPipe: class StreamPipe {
        constructor() {
          throw unavailable()
        }
      },
    }),
  }
}
