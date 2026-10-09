// libuv error codes and the exceptions C++ bindings throw (UVException in src/api/exceptions.cc).
import { SysError } from '../../process/syscalls.ts'
import { UV_ERRORS } from './data/uv-errors.ts'

const byCode = new Map(UV_ERRORS.map(([code, name, message]) => [code, { name, message }]))

/** The negative libuv code for any error raised by a syscall (Linux errno → -errno). */
export function uvCode(error: unknown): number {
  return error instanceof SysError ? -error.errno : -5 /* EIO */
}

export function uvName(code: number): string {
  return byCode.get(code)?.name ?? `Unknown system error ${code}`
}

export function uvMessage(code: number): string {
  return byCode.get(code)?.message ?? `Unknown system error ${code}`
}

export interface UVError extends Error {
  errno: number
  code: string
  syscall: string
  path?: string
  dest?: string
}

/** `ENOENT: no such file or directory, open '/x'` with errno/code/syscall/path, like Node's C++. */
export function uvException(error: unknown, syscall: string, path?: string, dest?: string): unknown {
  if (!(error instanceof SysError)) return error
  const code = uvCode(error)
  const name = uvName(code)
  let message = `${name}: ${uvMessage(code)}, ${syscall}`
  if (path !== undefined) message += ` '${path}'`
  if (dest !== undefined) message += ` -> '${dest}'`
  const result = new Error(message) as UVError
  result.errno = code
  result.code = name
  result.syscall = syscall
  if (path !== undefined) result.path = path
  if (dest !== undefined) result.dest = dest
  return result
}
