// Module records and graph algorithms behind internalBinding('module_wrap') (M1b).
//
// A source text module is a generator compiled by transform.ts; a synthetic module (CommonJS
// facades, builtins, JSON) has a fixed export list filled by setExport(). Both expose a module
// namespace object: null prototype, sorted live getters, Symbol.toStringTag 'Module'.
import type { CompiledModule } from './transform.ts'

// v8::Module::Status
export const kUninstantiated = 0
export const kInstantiating = 1
export const kInstantiated = 2
export const kEvaluating = 3
export const kEvaluated = 4
export const kErrored = 5

export interface ModuleHost {
  /** Compiles a generator function expression (transform output) for `url`. */
  compile(code: string, url: string): (scope: ModuleScope) => Generator | AsyncGenerator
  importMeta(record: ModuleRecord): object
  dynamicImport(record: ModuleRecord, specifier: unknown, options: unknown): Promise<unknown>
}

/** The `__wc` object a compiled module sees. */
export interface ModuleScope {
  /** Dependency namespaces, in request order. */
  d: object[]
  /** Registers the module's export getters (prologue). */
  x(getters: Record<string, () => unknown>): void
  readonly meta: object
  import(specifier: unknown, options?: unknown): Promise<unknown>
}

function createNamespace(): Record<PropertyKey, unknown> {
  const namespace = Object.create(null) as Record<PropertyKey, unknown>
  Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' })
  return namespace
}

export class ModuleRecord {
  readonly url: string
  readonly namespace = createNamespace()
  readonly compiled?: CompiledModule
  readonly exportNames?: string[]
  readonly evaluationSteps?: () => void
  /** The binding object (ModuleWrap) that owns this record; `this` for evaluation steps. */
  owner: object = this
  status = kUninstantiated
  error: unknown
  deps: ModuleRecord[] = []
  /** Pending evaluation of an async module (top-level await, or an async dependency). */
  evaluation?: Promise<void>
  private readonly host: ModuleHost
  private readonly values = new Map<string, unknown>()
  private getters: Record<string, () => unknown> = {}
  private generator?: Generator | AsyncGenerator
  private meta?: object

  private constructor(host: ModuleHost, url: string, compiled?: CompiledModule, exportNames?: string[], steps?: () => void) {
    this.host = host
    this.url = url
    this.compiled = compiled
    this.exportNames = exportNames
    this.evaluationSteps = steps
  }

  static sourceText(host: ModuleHost, url: string, compiled: CompiledModule): ModuleRecord {
    return new ModuleRecord(host, url, compiled)
  }

  static synthetic(host: ModuleHost, url: string, exportNames: string[], steps: () => void): ModuleRecord {
    return new ModuleRecord(host, url, undefined, [...new Set(exportNames)], steps)
  }

  get hasTopLevelAwait(): boolean {
    return this.compiled?.hasTopLevelAwait ?? false
  }

  setExport(name: string, value: unknown): void {
    this.values.set(name, value)
  }

  /** GetExportedNames: local, indirect and star exports (first star export wins on clashes). */
  exportedNames(visited = new Set<ModuleRecord>()): string[] {
    if (visited.has(this)) return []
    visited.add(this)
    if (!this.compiled) return this.exportNames ?? []
    const names = [...this.compiled.localExports, ...this.compiled.indirectExports.map((e) => e.name)]
    const seen = new Set(names)
    for (const index of this.compiled.starExports) {
      for (const name of this.deps[index]?.exportedNames(visited) ?? []) {
        if (name !== 'default' && !seen.has(name)) {
          seen.add(name)
          names.push(name)
        }
      }
    }
    return names
  }

  /** Where a namespace property reads from. */
  private resolve(name: string): () => unknown {
    if (!this.compiled) return () => this.values.get(name)
    if (this.compiled.localExports.includes(name)) return () => this.getters[name]()
    const indirect = this.compiled.indirectExports.find((e) => e.name === name)
    if (indirect) {
      const dep = this.deps[indirect.request]
      return indirect.importName === '*' ? () => dep.namespace : () => dep.namespace[indirect.importName]
    }
    for (const index of this.compiled.starExports) {
      const dep = this.deps[index]
      if (dep.exportedNames().includes(name)) return () => dep.namespace[name]
    }
    return () => undefined
  }

  defineNamespace(): void {
    for (const name of this.exportedNames().sort()) {
      if (Object.hasOwn(this.namespace, name)) continue
      Object.defineProperty(this.namespace, name, { get: this.resolve(name), enumerable: true, configurable: false })
    }
  }

  validateImports(): void {
    if (!this.compiled) return
    for (const { request, name } of this.compiled.imports) {
      if (name === '*' || this.deps[request].exportedNames().includes(name)) continue
      throw new SyntaxError(
        `The requested module '${this.compiled.requests[request].specifier}' does not provide an export named '${name}'`,
      )
    }
  }

  /** Runs the prologue: hoisting, export getters. */
  runPrologue(): void {
    if (!this.compiled || this.generator) return
    const record = this
    const scope: ModuleScope = {
      d: this.deps.map((dep) => dep.namespace),
      x: (getters) => (this.getters = getters),
      get meta() {
        return (record.meta ??= record.host.importMeta(record))
      },
      import: (specifier, options) => this.host.dynamicImport(this, specifier, options),
    }
    this.generator = this.host.compile(this.compiled.code, this.url).call(undefined, scope)
    this.generator.next()
  }

  /** Runs the module body (or synthetic evaluation steps). Async for top-level await. */
  execute(): void | Promise<unknown> {
    if (!this.compiled) {
      this.evaluationSteps?.call(this.owner)
      return undefined
    }
    const result = this.generator!.next()
    return result instanceof Promise ? result : undefined
  }

  fail(error: unknown): void {
    this.status = kErrored
    this.error = error
  }
}

function postOrder(root: ModuleRecord, include: (m: ModuleRecord) => boolean): ModuleRecord[] {
  const order: ModuleRecord[] = []
  const seen = new Set<ModuleRecord>()
  const visit = (record: ModuleRecord) => {
    if (seen.has(record) || !include(record)) return
    seen.add(record)
    for (const dep of record.deps) visit(dep)
    order.push(record)
  }
  visit(root)
  return order
}

/** Instantiates `root` and every not-yet-instantiated module it depends on. */
export function instantiate(root: ModuleRecord): void {
  const order = postOrder(root, (m) => m.status === kUninstantiated)
  for (const record of order) record.status = kInstantiating
  try {
    for (const record of order) record.defineNamespace()
    for (const record of order) record.validateImports()
    for (const record of order) record.runPrologue()
  } catch (error) {
    for (const record of order) record.status = kUninstantiated
    throw error
  }
  for (const record of order) {
    record.status = kInstantiated
    Object.preventExtensions(record.namespace)
  }
}

/** True when evaluating `root` would involve top-level await. */
export function hasAsyncGraph(root: ModuleRecord): boolean {
  return postOrder(root, () => true).some((m) => m.hasTopLevelAwait)
}

/**
 * Evaluates `root` after its dependencies (cycles are cut at modules already being evaluated).
 * Returns undefined when everything ran synchronously, or a promise when an async module is
 * involved; `sync` callers (require(esm)) get an error instead.
 */
export function evaluate(record: ModuleRecord, sync: boolean): void | Promise<void> {
  if (record.status === kErrored) throw record.error
  if (record.status === kEvaluated) return record.evaluation
  if (record.status === kEvaluating) return undefined
  record.status = kEvaluating
  const pending: Promise<void>[] = []
  try {
    for (const dep of record.deps) {
      const result = evaluate(dep, sync)
      if (result) pending.push(result)
    }
  } catch (error) {
    record.fail(error)
    throw error
  }

  if (!pending.length && !record.hasTopLevelAwait) {
    try {
      record.execute()
    } catch (error) {
      record.fail(error)
      throw error
    }
    record.status = kEvaluated
    return undefined
  }
  if (sync) {
    const error = new Error(`${record.url} uses top-level await and cannot be evaluated synchronously`)
    record.fail(error)
    throw error
  }
  record.status = kEvaluated
  record.evaluation = Promise.all(pending)
    .then(() => record.execute())
    .then(
      () => undefined,
      (error) => {
        record.fail(error)
        throw error
      },
    )
  return record.evaluation
}
