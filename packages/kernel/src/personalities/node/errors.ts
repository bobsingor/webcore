import { errnoMessage, errnoName } from '../../abi/errno.ts'
import { SysError } from '../../process/syscalls.ts'

export interface NodeSystemError extends Error {
  errno: number
  code: string
  syscall: string
  path?: string
  dest?: string
}

/** Converts a kernel error into Node's shape: `ENOENT: no such file or directory, open '/x'`. */
export function systemError(error: unknown, syscall: string, path?: string, dest?: string): unknown {
  if (!(error instanceof SysError)) return error
  const code = errnoName(error.errno)
  let message = `${code}: ${errnoMessage(error.errno)}, ${syscall}`
  if (path !== undefined) message += ` '${path}'`
  if (dest !== undefined) message += ` -> '${dest}'`
  const result = new Error(message) as NodeSystemError
  result.errno = -error.errno
  result.code = code
  result.syscall = syscall
  if (path !== undefined) result.path = path
  if (dest !== undefined) result.dest = dest
  return result
}
