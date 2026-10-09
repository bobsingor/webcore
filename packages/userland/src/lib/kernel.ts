// The kernel ABI (`process.webcore`), for programs that need more than Node's APIs offer:
// unpacking archives in the kernel (npm).

interface WebcoreApi {
  syscall(name: string, ...args: unknown[]): unknown
  syscallAsync(name: string, ...args: unknown[]): Promise<unknown>
}

function api(): WebcoreApi {
  const webcore = (process as unknown as { webcore?: WebcoreApi }).webcore
  if (!webcore) throw new Error("This program needs webcore's kernel (process.webcore is missing)")
  return webcore
}

/** A failed syscall: `code` is the errno name, e.g. ENOENT. */
export interface SysError extends Error {
  code: string
  errno: number
}

export function isSysError(error: unknown, code?: string): error is SysError {
  return error instanceof Error && typeof (error as SysError).code === 'string' && (code === undefined || (error as SysError).code === code)
}

export const sys = {
  extract: (archive: Uint8Array, dir: string, options: { strip?: number; integrity?: string }) =>
    api().syscallAsync('extract', archive, dir, options) as Promise<number>,
}
