// internalBinding('fs'), ('fs_dir') and ('modules') over kernel syscalls (src/node_file.cc,
// src/node_dir.cc, src/node_modules.cc).
//
// Calling convention: no request object → synchronous, throwing UV-style errors; an
// FSReqCallback → the result is delivered through req.oncomplete; kUsePromises → a promise.
// Asynchronous calls use async syscalls where the kernel can block (reads, writes to pipes);
// everything else runs synchronously in a deferred macrotask.
import { O_CREAT, O_DIRECTORY, O_EXCL, O_RDONLY, O_TRUNC, O_WRONLY, SEEK_CUR, SEEK_SET } from '../../../abi/constants.ts'
import type { Dirent, FileType, Stat } from '../../../abi/constants.ts'
import { Errno } from '../../../abi/errno.ts'
import { SysError } from '../../../process/syscalls.ts'
import { bytesOf, decode, encode } from '../codec.ts'
import type { Realm } from '../realm.ts'
import { uvCode, uvException } from '../uv.ts'
import { host } from '../host.ts'

const kFsStatsFieldsNumber = 18
const UV_DIRENT: Record<FileType, number> = { file: 1, dir: 2, fifo: 4, socket: 5, chardev: 6 }
const COPYFILE_EXCL = 1

type Request = { oncomplete(error: unknown, value?: unknown): void } | symbol | undefined
type Position = number | bigint | null | undefined

function timespec(ms: number): [number, number] {
  const seconds = Math.floor(ms / 1000)
  return [seconds, Math.round((ms - seconds * 1000) * 1e6)]
}

function statValues(stat: Stat, bigint: boolean): Float64Array | BigInt64Array {
  const values = [
    1, stat.mode, stat.nlink, 1000, 1000, 0, 4096, stat.ino, stat.size, Math.ceil(stat.size / 512),
    ...timespec(stat.atimeMs), ...timespec(stat.mtimeMs), ...timespec(stat.ctimeMs), ...timespec(stat.birthtimeMs),
  ]
  return bigint ? BigInt64Array.from(values, (value) => BigInt(value)) : Float64Array.from(values)
}

function pathOf(path: unknown): string {
  if (typeof path === 'string') return path
  if (path instanceof Uint8Array) return decode(path, 'utf8')
  return String(path)
}

function isPositioned(position: Position): boolean {
  return position !== null && position !== undefined && Number(position) >= 0
}

function isErrno(error: unknown, errno: number): boolean {
  return error instanceof SysError && error.errno === errno
}

export function fsBindings() {
  return {
    fs: (realm: Realm) => {
      const { sys, loop } = realm
      const kUsePromises = realm.perIsolateSymbols.fs_use_promises_symbol

      function dispatch<T>(
        req: Request,
        context: [syscall: string, path?: string, dest?: string],
        sync: () => T,
        async?: () => Promise<T>,
      ): T | Promise<T> | undefined {
        const fail = (error: unknown) => uvException(error, ...context)
        if (req === undefined) {
          try {
            return sync()
          } catch (error) {
            throw fail(error)
          }
        }
        const run =
          async ??
          (() =>
            new Promise<T>((resolve, reject) =>
              loop.defer(() => {
                try {
                  resolve(sync())
                } catch (error) {
                  reject(error)
                }
              }),
            ))
        loop.requestStarted()
        const settled = run().finally(() => loop.requestFinished())
        if (req === kUsePromises) {
          return settled.catch((error) => {
            throw fail(error)
          })
        }
        const callbackRequest = req as Exclude<Request, symbol | undefined>
        settled.then(
          (value) => loop.callback(() => callbackRequest.oncomplete(null, value)),
          (error) => loop.callback(() => callbackRequest.oncomplete(fail(error))),
        )
        return undefined
      }

      const readAll = (fd: number): Uint8Array => {
        const chunks: Uint8Array[] = []
        let total = 0
        for (;;) {
          const chunk = sys.call('read', fd, sys.maxPayload)
          if (!chunk.length) break
          chunks.push(chunk)
          total += chunk.length
        }
        const out = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          out.set(chunk, offset)
          offset += chunk.length
        }
        return out
      }

      const withFile = <T>(path: string | number, flags: number, mode: number, fn: (fd: number) => T): T => {
        if (typeof path === 'number') return fn(path)
        const fd = sys.call('open', path, flags, mode)
        try {
          return fn(fd)
        } finally {
          sys.call('close', fd)
        }
      }

      /** pread/pwrite semantics: a non-negative position leaves the file offset unchanged. */
      const atPosition = <T>(fd: number, position: Position, fn: () => T): T => {
        if (!isPositioned(position)) return fn()
        const saved = sys.call('seek', fd, 0, SEEK_CUR)
        sys.call('seek', fd, Number(position), SEEK_SET)
        try {
          return fn()
        } finally {
          sys.call('seek', fd, saved, SEEK_SET)
        }
      }

      const names = (entries: Dirent[], encoding: unknown) =>
        entries.map((entry) => (encoding === 'buffer' ? realm.newBuffer(encode(entry.name, 'utf8')) : entry.name))

      const listDirectory = (path: string): Dirent[] => {
        const fd = sys.call('open', path, O_RDONLY | O_DIRECTORY, 0)
        try {
          return sys.call('getdents', fd)
        } finally {
          sys.call('close', fd)
        }
      }

      const stat = (path: string) => sys.call('stat', path)

      const mkdirp = (path: string, mode: number): string | undefined => {
        const absolute = path.startsWith('/') ? path : `${sys.call('getcwd')}/${path}`
        let first: string | undefined
        let current = ''
        for (const part of absolute.split('/').filter(Boolean)) {
          current += `/${part}`
          try {
            sys.call('mkdir', current, mode)
            first ??= current
          } catch (error) {
            if (!isErrno(error, Errno.EEXIST)) throw error
            if (stat(current).type !== 'dir') throw new SysError(Errno.ENOTDIR, 'mkdir')
          }
        }
        return first
      }

      const removeTree = (path: string): void => {
        if (stat(path).type === 'dir') {
          for (const entry of listDirectory(path)) removeTree(`${path}/${entry.name}`)
          sys.call('rmdir', path)
        } else {
          sys.call('unlink', path)
        }
      }

      class FSReqCallback {
        bigint: boolean
        oncomplete?: (error: unknown, value?: unknown) => void
        context?: unknown
        constructor(bigint = false) {
          this.bigint = bigint
        }
      }

      class FileHandle {
        #fd: number
        constructor(fd: number) {
          this.#fd = fd
        }
        get fd() {
          return this.#fd
        }
        getAsyncId() {
          return -1
        }
        close() {
          const fd = this.#fd
          return dispatch(kUsePromises, ['close'], () => {
            this.#fd = -1
            sys.call('close', fd)
          })
        }
        releaseFD() {
          const fd = this.#fd
          this.#fd = -1
          return fd
        }
      }

      return {
        kUsePromises,
        kFsStatsFieldsNumber,
        statValues: new Float64Array(2 * kFsStatsFieldsNumber),
        bigintStatValues: new BigInt64Array(2 * kFsStatsFieldsNumber),
        statFsValues: new Float64Array(8),
        bigintStatFsValues: new BigInt64Array(8),
        FSReqCallback,
        FileHandle,
        StatWatcher: class StatWatcher {
          start() {
            return 0
          }
          close() {}
          ref() {}
          unref() {}
        },

        access: (path: unknown, _mode: number, req?: Request) =>
          dispatch(req, ['access', pathOf(path)], () => void stat(pathOf(path))),
        existsSync: (path: unknown) => {
          try {
            stat(pathOf(path))
            return true
          } catch {
            return false
          }
        },
        open: (path: unknown, flags: number, mode: number, req?: Request) =>
          dispatch(req, ['open', pathOf(path)], () => sys.call('open', pathOf(path), flags, mode)),
        openFileHandle: (path: unknown, flags: number, mode: number, req?: Request) =>
          dispatch(req, ['open', pathOf(path)], () => new FileHandle(sys.call('open', pathOf(path), flags, mode))),
        close: (fd: number, req?: Request) => dispatch(req, ['close'], () => void sys.call('close', fd)),

        read: (fd: number, buffer: Uint8Array, offset: number, length: number, position: Position, req?: Request) => {
          const target = bytesOf(buffer)
          const max = Math.min(length, sys.maxPayload)
          const store = (data: Uint8Array) => {
            target.set(data, offset)
            return data.length
          }
          const async = isPositioned(position)
            ? undefined
            : () => sys.callAsync('read', fd, max).then(store)
          return dispatch(req, ['read'], () => atPosition(fd, position, () => store(sys.call('read', fd, max))), async)
        },
        readBuffers: (fd: number, buffers: Uint8Array[], position: Position, req?: Request) =>
          dispatch(req, ['read'], () =>
            atPosition(fd, position, () => {
              let total = 0
              for (const buffer of buffers) {
                const data = sys.call('read', fd, Math.min(buffer.byteLength, sys.maxPayload))
                bytesOf(buffer).set(data)
                total += data.length
                if (data.length < buffer.byteLength) break
              }
              return total
            }),
          ),
        writeBuffer: (fd: number, buffer: Uint8Array, offset: number, length: number, position: Position, req?: Request) => {
          const data = bytesOf(buffer).slice(offset, offset + length)
          const async = isPositioned(position) ? undefined : () => sys.callAsync('write', fd, data)
          return dispatch(req, ['write'], () => atPosition(fd, position, () => sys.call('write', fd, data)), async)
        },
        writeBuffers: (fd: number, buffers: Uint8Array[], position: Position, req?: Request) => {
          const parts = buffers.map((buffer) => bytesOf(buffer))
          const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
          let offset = 0
          for (const part of parts) {
            data.set(part, offset)
            offset += part.length
          }
          const async = isPositioned(position) ? undefined : () => sys.callAsync('write', fd, data)
          return dispatch(req, ['write'], () => atPosition(fd, position, () => sys.call('write', fd, data)), async)
        },
        writeString: (fd: number, text: string, position: Position, encoding: string, req?: Request) => {
          const data = encode(text, encoding)
          const async = isPositioned(position) ? undefined : () => sys.callAsync('write', fd, data)
          return dispatch(req, ['write'], () => atPosition(fd, position, () => sys.call('write', fd, data)), async)
        },

        readFileUtf8: (path: unknown, flags: number) => {
          const target = typeof path === 'number' ? path : pathOf(path)
          return dispatch(undefined, ['open', typeof target === 'string' ? target : undefined], () =>
            decode(withFile(target, flags, 0o666, readAll), 'utf8'),
          )
        },
        writeFileUtf8: (path: unknown, data: string, flags: number, mode: number) => {
          const target = typeof path === 'number' ? path : pathOf(path)
          dispatch(undefined, ['open', typeof target === 'string' ? target : undefined], () =>
            withFile(target, flags, mode, (fd) => sys.call('write', fd, encode(data, 'utf8'))),
          )
        },

        stat: (path: unknown, bigint: boolean, req?: Request, throwIfNoEntry = true) => {
          const target = pathOf(path)
          if (req === undefined && !throwIfNoEntry) {
            try {
              return statValues(stat(target), bigint)
            } catch (error) {
              if (isErrno(error, Errno.ENOENT) || isErrno(error, Errno.ENOTDIR)) return undefined
              throw uvException(error, 'stat', target)
            }
          }
          return dispatch(req, ['stat', target], () => statValues(stat(target), bigint))
        },
        lstat: (path: unknown, bigint: boolean, req?: Request, throwIfNoEntry = true) => {
          const target = pathOf(path)
          if (req === undefined && !throwIfNoEntry) {
            try {
              return statValues(stat(target), bigint)
            } catch (error) {
              if (isErrno(error, Errno.ENOENT) || isErrno(error, Errno.ENOTDIR)) return undefined
              throw uvException(error, 'lstat', target)
            }
          }
          return dispatch(req, ['lstat', target], () => statValues(stat(target), bigint))
        },
        fstat: (fd: number, bigint: boolean, req?: Request, shouldNotThrow = false) => {
          if (req === undefined && shouldNotThrow) {
            try {
              return statValues(sys.call('fstat', fd), bigint)
            } catch {
              return undefined
            }
          }
          return dispatch(req, ['fstat'], () => statValues(sys.call('fstat', fd), bigint))
        },
        statfs: (path: unknown, bigint: boolean, req?: Request) =>
          dispatch(req, ['statfs', pathOf(path)], () => {
            stat(pathOf(path))
            const values = [0x01021994, 4096, 1 << 20, 1 << 19, 1 << 19, 1 << 20, 1 << 19, 0]
            return bigint ? BigInt64Array.from(values, BigInt) : Float64Array.from(values)
          }),
        // The legacy "main" lookup of the ESM resolver: returns an index into
        // legacyMainResolveExtensions (lib/internal/modules/esm/resolve.js).
        legacyMainResolve: (packagePath: string, main: unknown, base: string | undefined) => {
          const isFile = (path: string) => {
            try {
              return stat(path).type === 'file'
            } catch {
              return false
            }
          }
          const join = (relative: string) => `${packagePath.replace(/\/$/, '')}/${relative.replace(/^\.\//, '')}`
          if (typeof main === 'string') {
            const candidates = ['', '.js', '.json', '.node', '/index.js', '/index.json', '/index.node']
            const found = candidates.findIndex((suffix) => isFile(join(`${main}${suffix}`)))
            if (found >= 0) return found
          }
          const found = ['index.js', 'index.json', 'index.node'].findIndex((file) => isFile(join(file)))
          if (found >= 0) return 7 + found
          const { ERR_MODULE_NOT_FOUND } = (realm.requireBuiltin('internal/errors') as { codes: Record<string, new (...args: unknown[]) => Error> }).codes
          throw new ERR_MODULE_NOT_FOUND(packagePath, base)
        },
        internalModuleStat: (path: unknown) => {
          try {
            return stat(pathOf(path)).type === 'dir' ? 1 : 0
          } catch (error) {
            return uvCode(error)
          }
        },
        getFormatOfExtensionlessFile: (path: unknown) => {
          try {
            const head = withFile(pathOf(path), O_RDONLY, 0, (fd) => sys.call('read', fd, 4))
            return head.length === 4 && head[0] === 0 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d ? 1 : 0
          } catch {
            return 0
          }
        },

        readdir: (path: unknown, encoding: unknown, withTypes: boolean, req?: Request) =>
          dispatch(req, ['scandir', pathOf(path)], () => {
            const entries = listDirectory(pathOf(path))
            return withTypes ? [names(entries, encoding), entries.map((entry) => UV_DIRENT[entry.type] ?? 0)] : names(entries, encoding)
          }),
        mkdir: (path: unknown, mode: number, recursive: boolean, req?: Request) =>
          dispatch(req, ['mkdir', pathOf(path)], () =>
            recursive ? mkdirp(pathOf(path), mode) : void sys.call('mkdir', pathOf(path), mode),
          ),
        mkdtemp: (prefix: unknown, encoding: unknown, req?: Request) =>
          dispatch(req, ['mkdtemp', `${pathOf(prefix)}XXXXXX`], () => {
            for (;;) {
              const candidate = `${pathOf(prefix)}${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`
              try {
                sys.call('mkdir', candidate, 0o700)
                return encoding === 'buffer' ? realm.newBuffer(encode(candidate, 'utf8')) : candidate
              } catch (error) {
                if (!isErrno(error, Errno.EEXIST)) throw error
              }
            }
          }),
        rmdir: (path: unknown, req?: Request) => dispatch(req, ['rmdir', pathOf(path)], () => void sys.call('rmdir', pathOf(path))),
        rmSync: (path: unknown, _maxRetries: number, recursive: boolean) =>
          dispatch(undefined, ['rm', pathOf(path)], () => {
            const target = pathOf(path)
            if (stat(target).type === 'dir' && !recursive) throw new SysError(Errno.EISDIR, 'rm')
            removeTree(target)
          }),
        unlink: (path: unknown, req?: Request) => dispatch(req, ['unlink', pathOf(path)], () => void sys.call('unlink', pathOf(path))),
        rename: (from: unknown, to: unknown, req?: Request) =>
          dispatch(req, ['rename', pathOf(from), pathOf(to)], () => void sys.call('rename', pathOf(from), pathOf(to))),
        ftruncate: (fd: number, length: number, req?: Request) =>
          dispatch(req, ['ftruncate'], () => void sys.call('ftruncate', fd, Number(length))),
        copyFile: (from: unknown, to: unknown, mode: number, req?: Request) =>
          dispatch(req, ['copyfile', pathOf(from), pathOf(to)], () => {
            const data = withFile(pathOf(from), O_RDONLY, 0, readAll)
            const flags = O_WRONLY | O_CREAT | O_TRUNC | (mode & COPYFILE_EXCL ? O_EXCL : 0)
            withFile(pathOf(to), flags, 0o666, (fd) => sys.call('write', fd, data))
          }),
        realpath: (path: unknown, encoding: unknown, req?: Request) =>
          dispatch(req, ['realpath', pathOf(path)], () => {
            const target = pathOf(path)
            const absolute = target.startsWith('/') ? target : `${sys.call('getcwd')}/${target}`
            stat(absolute)
            const parts: string[] = []
            for (const part of absolute.split('/')) {
              if (!part || part === '.') continue
              if (part === '..') parts.pop()
              else parts.push(part)
            }
            const resolved = `/${parts.join('/')}`
            return encoding === 'buffer' ? realm.newBuffer(encode(resolved, 'utf8')) : resolved
          }),
        // The VFS has no symbolic links yet (M1d): nothing is a link, and links can't be created.
        readlink: (path: unknown, _encoding: unknown, req?: Request) =>
          dispatch(req, ['readlink', pathOf(path)], () => {
            stat(pathOf(path))
            throw new SysError(Errno.EINVAL, 'readlink')
          }),
        symlink: (target: unknown, path: unknown, _flags: number, req?: Request) =>
          dispatch(req, ['symlink', pathOf(target), pathOf(path)], () => {
            throw new SysError(Errno.ENOSYS, 'symlink')
          }),
        link: (from: unknown, to: unknown, req?: Request) =>
          dispatch(req, ['link', pathOf(from), pathOf(to)], () => {
            throw new SysError(Errno.ENOSYS, 'link')
          }),
        // Permissions, ownership and timestamps are not modelled yet: validate the target, then succeed.
        chmod: (path: unknown, _mode: number, req?: Request) => dispatch(req, ['chmod', pathOf(path)], () => void stat(pathOf(path))),
        lchmod: (path: unknown, _mode: number, req?: Request) => dispatch(req, ['lchmod', pathOf(path)], () => void stat(pathOf(path))),
        chown: (path: unknown, _uid: number, _gid: number, req?: Request) => dispatch(req, ['chown', pathOf(path)], () => void stat(pathOf(path))),
        lchown: (path: unknown, _uid: number, _gid: number, req?: Request) => dispatch(req, ['lchown', pathOf(path)], () => void stat(pathOf(path))),
        utimes: (path: unknown, _atime: number, _mtime: number, req?: Request) => dispatch(req, ['utime', pathOf(path)], () => void stat(pathOf(path))),
        lutimes: (path: unknown, _atime: number, _mtime: number, req?: Request) => dispatch(req, ['lutime', pathOf(path)], () => void stat(pathOf(path))),
        fchmod: (fd: number, _mode: number, req?: Request) => dispatch(req, ['fchmod'], () => void sys.call('fstat', fd)),
        fchown: (fd: number, _uid: number, _gid: number, req?: Request) => dispatch(req, ['fchown'], () => void sys.call('fstat', fd)),
        futimes: (fd: number, _atime: number, _mtime: number, req?: Request) => dispatch(req, ['futime'], () => void sys.call('fstat', fd)),
        fsync: (fd: number, req?: Request) => dispatch(req, ['fsync'], () => void sys.call('fstat', fd)),
        fdatasync: (fd: number, req?: Request) => dispatch(req, ['fdatasync'], () => void sys.call('fstat', fd)),
      }
    },

    fs_dir: (realm: Realm) => {
      class DirHandle {
        private entries: Dirent[]
        private index = 0
        constructor(entries: Dirent[]) {
          this.entries = entries
        }
        read(_encoding: unknown, bufferSize: number, req?: { oncomplete(error: unknown, value?: unknown): void }) {
          const batch = this.entries.slice(this.index, this.index + Math.max(1, bufferSize))
          this.index += batch.length
          const result = batch.length ? batch.flatMap((entry) => [entry.name, UV_DIRENT[entry.type] ?? 0]) : null
          if (!req) return result
          realm.loop.macrotask(() => req.oncomplete(null, result))
          return undefined
        }
        close(req?: { oncomplete(error: unknown): void }) {
          if (req) realm.loop.macrotask(() => req.oncomplete(null))
        }
      }
      const open = (path: unknown): DirHandle => {
        const target = pathOf(path)
        try {
          const fd = realm.sys.call('open', target, O_RDONLY | O_DIRECTORY, 0)
          try {
            return new DirHandle(realm.sys.call('getdents', fd))
          } finally {
            realm.sys.call('close', fd)
          }
        } catch (error) {
          throw uvException(error, 'opendir', target)
        }
      }
      return {
        DirHandle,
        opendirSync: (path: unknown) => open(path),
        opendir: (path: unknown, _encoding: unknown, req?: { oncomplete(error: unknown, value?: unknown): void }) => {
          if (!req) return open(path)
          realm.loop.macrotask(() => {
            try {
              req.oncomplete(null, open(path))
            } catch (error) {
              req.oncomplete(error)
            }
          })
          return undefined
        },
      }
    },

    // Package.json lookups (src/node_modules.cc). Results are serialized as
    // [name, main, type, imports, exports, path]; imports/exports stay JSON text.
    modules: (realm: Realm) => {
      const { sys } = realm
      type Serialized = [string | undefined, string | undefined, string, string | null, string | null, string]
      const cache = new Map<string, Serialized | undefined>()

      const read = (path: string): Serialized | undefined => {
        if (cache.has(path)) return cache.get(path)
        let text: string
        try {
          const fd = sys.call('open', path, O_RDONLY, 0)
          try {
            const chunks: Uint8Array[] = []
            for (let chunk = sys.call('read', fd, sys.maxPayload); chunk.length; chunk = sys.call('read', fd, sys.maxPayload)) chunks.push(chunk)
            text = new host.TextDecoder().decode(new Uint8Array(chunks.flatMap((chunk) => [...chunk])))
          } finally {
            sys.call('close', fd)
          }
        } catch {
          cache.set(path, undefined)
          return undefined
        }
        let json: Record<string, unknown>
        try {
          json = JSON.parse(text)
        } catch (error) {
          const { ERR_INVALID_PACKAGE_CONFIG } = (realm.requireBuiltin('internal/errors') as { codes: Record<string, new (...args: unknown[]) => Error> }).codes
          throw new ERR_INVALID_PACKAGE_CONFIG(path, undefined, (error as Error).message)
        }
        const serialize = (value: unknown) => (value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value))
        const result: Serialized = [
          typeof json.name === 'string' ? json.name : undefined,
          typeof json.main === 'string' ? json.main : undefined,
          json.type === 'module' || json.type === 'commonjs' ? json.type : 'none',
          serialize(json.imports),
          serialize(json.exports),
          path,
        ]
        cache.set(path, result)
        return result
      }

      const dirname = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '/'
      const findUp = (start: string): Serialized | string => {
        let directory = start
        for (;;) {
          const candidate = `${directory === '/' ? '' : directory}/package.json`
          const found = read(candidate)
          if (found) return found
          if (directory === '/' || directory.endsWith('/node_modules')) return candidate
          directory = dirname(directory)
        }
      }
      const fileOf = (url: string) => (url.startsWith('file:') ? decodeURIComponent(new host.URL(url).pathname) : url)

      return {
        readPackageJSON: (path: string) => read(path),
        getNearestParentPackageJSON: (checkPath: string) => {
          const found = findUp(dirname(checkPath))
          return typeof found === 'string' ? undefined : found
        },
        getNearestParentPackageJSONType: (checkPath: string) => {
          const found = findUp(dirname(checkPath))
          return typeof found === 'string' ? 'none' : found[2]
        },
        getPackageScopeConfig: (resolved: string) => findUp(dirname(fileOf(resolved))),
        getPackageType: (url: string) => {
          const found = findUp(dirname(fileOf(url)))
          return typeof found === 'string' ? undefined : found[2]
        },
        enableCompileCache: () => [0],
        getCompileCacheDir: () => undefined,
        flushCompileCache: () => {},
        getCompileCacheEntry: () => undefined,
        saveCompileCacheEntry: () => {},
        compileCacheStatus: ['FAILED', 'ENABLED', 'ALREADY_ENABLED', 'DISABLED'],
        cachedCodeTypes: { kStrippedTypeScript: 0, kTransformedTypeScript: 1, kTransformedTypeScriptWithSourceMaps: 2 },
        // import.meta.filename / import.meta.dirname for file: URLs (lazy, like Node's C++).
        setLazyPathHelpers: (meta: object, url: string) => {
          const filename = () => decodeURIComponent(new host.URL(url).pathname)
          const lazy = (key: string, compute: () => string) =>
            Object.defineProperty(meta, key, {
              configurable: true,
              enumerable: true,
              get() {
                const value = compute()
                Object.defineProperty(meta, key, { value, writable: true, configurable: true, enumerable: true })
                return value
              },
            })
          lazy('filename', filename)
          lazy('dirname', () => filename().replace(/\/[^/]*$/, '') || '/')
        },
      }
    },
  }
}
