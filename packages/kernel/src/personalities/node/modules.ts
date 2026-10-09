// CommonJS loader (M0). Resolves relative paths, node_modules and package.json "main".
// ES modules and package "exports" arrive with Node's own loader in M1 (ADR-0005).
import type { NodePath } from './path.ts'

export interface NodeRequire {
  (request: string): unknown
  resolve(request: string): string
  cache: Record<string, NodeModule>
  main: NodeModule | undefined
}

export interface NodeModule {
  id: string
  filename: string
  path: string
  exports: unknown
  loaded: boolean
  parent: NodeModule | null
  children: NodeModule[]
  paths: string[]
  require: NodeRequire
}

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string | Uint8Array
  statSync(path: string, options: { throwIfNoEntry: false }): { isFile(): boolean; isDirectory(): boolean } | undefined
}

const WRAPPER_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname']

export class ModuleSystem {
  readonly cache: Record<string, NodeModule> = Object.create(null)
  main: NodeModule | undefined
  private readonly fs: FsLike
  private readonly path: NodePath
  private readonly builtins: Record<string, () => unknown>
  private readonly loadedBuiltins = new Map<string, unknown>()

  constructor(fs: FsLike, path: NodePath, builtins: Record<string, () => unknown>) {
    this.fs = fs
    this.path = path
    this.builtins = builtins
  }

  get builtinModules(): string[] {
    return Object.keys(this.builtins)
  }

  createRequire(parent: NodeModule | undefined, directory: string): NodeRequire {
    const require = ((request: string) => this.require(request, directory, parent)) as NodeRequire
    require.resolve = (request: string) => this.resolve(request, directory)
    require.cache = this.cache
    require.main = this.main
    return require
  }

  /** Runs source text as the main module (`node -e`, `node -p`, a script piped to stdin). */
  runSource(filename: string, source: string, directory: string, returnResult = false): unknown {
    const module = this.createModule('.', filename, directory, null)
    this.main = module.require.main = module
    const body = returnResult ? `return eval(${JSON.stringify(source)})` : source
    return this.evaluate(module, body)
  }

  /** Runs a file as the main module (`node app.js`). */
  runFile(request: string, directory: string): void {
    const filename = this.resolve(request.startsWith('/') ? request : `./${request}`, directory)
    const module = this.createModule('.', filename, this.path.dirname(filename), null)
    this.main = module.require.main = module
    this.cache[filename] = module
    this.evaluate(module, this.read(filename))
    module.loaded = true
  }

  resolve(request: string, directory: string): string {
    if (this.isBuiltin(request)) return request
    if (/^\.\.?(\/|$)/.test(request) || request.startsWith('/')) {
      const found = this.resolveFile(this.path.resolve(directory, request))
      if (found) return found
    } else {
      for (let current = directory; ; current = this.path.dirname(current)) {
        const found = this.resolveFile(this.path.join(current, 'node_modules', request))
        if (found) return found
        if (current === '/') break
      }
    }
    throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' })
  }

  private require(request: string, directory: string, parent?: NodeModule): unknown {
    if (typeof request !== 'string' || !request) {
      throw new TypeError(`The "id" argument must be a non-empty string. Received ${String(request)}`)
    }
    const builtin = request.startsWith('node:') ? request.slice(5) : request
    if (Object.hasOwn(this.builtins, builtin)) {
      if (!this.loadedBuiltins.has(builtin)) this.loadedBuiltins.set(builtin, this.builtins[builtin]())
      return this.loadedBuiltins.get(builtin)
    }
    if (request.startsWith('node:')) {
      throw Object.assign(new Error(`No such built-in module: ${request}`), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' })
    }
    const filename = this.resolve(request, directory)
    const cached = this.cache[filename]
    if (cached) return cached.exports

    const module = this.createModule(filename, filename, this.path.dirname(filename), parent ?? null)
    this.cache[filename] = module
    parent?.children.push(module)
    try {
      const source = this.read(filename)
      if (filename.endsWith('.json')) module.exports = JSON.parse(source)
      else this.evaluate(module, source)
    } catch (error) {
      delete this.cache[filename]
      throw error
    }
    module.loaded = true
    return module.exports
  }

  private isBuiltin(request: string): boolean {
    return Object.hasOwn(this.builtins, request.startsWith('node:') ? request.slice(5) : request)
  }

  private createModule(id: string, filename: string, directory: string, parent: NodeModule | null): NodeModule {
    const module = {
      id,
      filename,
      path: directory,
      exports: {},
      loaded: false,
      parent,
      children: [],
      paths: [],
    } as unknown as NodeModule
    module.require = this.createRequire(module, directory)
    return module
  }

  private evaluate(module: NodeModule, source: string): unknown {
    const body = source.startsWith('#!') ? `//${source}` : source
    let wrapper: (...args: unknown[]) => unknown
    try {
      wrapper = new Function(...WRAPPER_PARAMS, `${body}\n//# sourceURL=${module.filename}`) as typeof wrapper
    } catch (error) {
      if (error instanceof SyntaxError && /\b(import|export)\b/.test(error.message)) {
        error.message += ' (webcore M0 runs CommonJS only; ES modules arrive in M1)'
      }
      throw error
    }
    return wrapper.call(module.exports, module.exports, module.require, module, module.filename, module.path)
  }

  private read(filename: string): string {
    return String(this.fs.readFileSync(filename, 'utf8'))
  }

  private resolveFile(base: string): string | undefined {
    for (const candidate of [base, `${base}.js`, `${base}.json`, `${base}.cjs`]) {
      if (this.fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate
    }
    if (!this.fs.statSync(base, { throwIfNoEntry: false })?.isDirectory()) return undefined
    const manifest = `${base}/package.json`
    if (this.fs.statSync(manifest, { throwIfNoEntry: false })?.isFile()) {
      try {
        const main = JSON.parse(this.read(manifest)).main
        if (typeof main === 'string') {
          const found = this.resolveFile(this.path.resolve(base, main))
          if (found) return found
        }
      } catch {
        // Malformed package.json: fall back to index files, like Node.
      }
    }
    for (const index of ['index.js', 'index.json', 'index.cjs']) {
      if (this.fs.statSync(`${base}/${index}`, { throwIfNoEntry: false })?.isFile()) return `${base}/${index}`
    }
    return undefined
  }
}
