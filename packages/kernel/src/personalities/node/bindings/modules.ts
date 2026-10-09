// contextify (CommonJS and vm scripts), module_wrap (ES modules) and cjs_lexer.
import { compileFunction, evaluateExpression, runScript } from '../compile.ts'
import { createVmContext, type VmContext } from '../vmcontext.ts'
import {
  evaluate,
  hasAsyncGraph,
  instantiate,
  kErrored,
  kEvaluated,
  kEvaluating,
  kInstantiated,
  kInstantiating,
  kUninstantiated,
  ModuleRecord,
  type ModuleHost,
  type ModuleScope,
} from '../esm/module.ts'
import { compileModule, kEvaluationPhase, kSourcePhase, rewriteDynamicImports, sourceMapUrlOf } from '../esm/transform.ts'
import type { Realm } from '../realm.ts'

const CJS_PARAMETERS = ['exports', 'require', 'module', '__filename', '__dirname']
// SyntaxErrors that mean "this is an ES module" (src/node_contextify.cc, esm_syntax_error_messages).
const ESM_SYNTAX_ERRORS = [
  /Cannot use import statement outside a module/,
  /Unexpected token 'export'/,
  /Cannot use 'import\.meta' outside a module/,
  /await is only valid in async functions/,
  /Unexpected reserved word/,
]

function looksLikeEsm(error: unknown): boolean {
  return error instanceof SyntaxError && ESM_SYNTAX_ERRORS.some((pattern) => pattern.test(error.message))
}

export function moduleBindings() {
  return {
    contextify: (realm: Realm) => {
      const hostDefinedOption = realm.privateSymbols.host_defined_option_symbol
      const contextSymbol = realm.privateSymbols.contextify_context_private_symbol
      const contextOf = (object: object): VmContext => {
        const context = (object as Record<symbol, VmContext | undefined>)[contextSymbol]
        if (!context) throw new TypeError('The "contextifiedObject" argument must be an vm.Context')
        return context
      }
      const defaultInternal = realm.perIsolateSymbols.vm_dynamic_import_default_internal

      class ContextifyScript {
        private readonly source: string
        private readonly filename: string
        sourceMapURL: string | undefined
        cachedDataRejected = false

        constructor(
          code: string,
          filename = 'evalmachine.<anonymous>',
          _lineOffset?: number,
          _columnOffset?: number,
          _cachedData?: unknown,
          _produceCachedData?: boolean,
          _parsingContext?: unknown,
          hostDefinedOptionId?: symbol,
        ) {
          this.source = rewriteDynamicImports(code, () => realm.acorn, () => realm.importCallFor(hostDefinedOptionId, filename), 'script')
          this.filename = filename
          this.sourceMapURL = sourceMapUrlOf(code)
          // Identifies the dynamic-import callback registry for this script (src/node_contextify.cc).
          ;(this as Record<symbol, unknown>)[hostDefinedOption] = hostDefinedOptionId
          // Compile eagerly so syntax errors surface at construction, as with V8.
          compileFunction([], this.source, filename)
        }

        runInThisContext() {
          return runScript(this.source, this.filename)
        }

        /** A null context means the current one (vm.runInThisContext). */
        runInContext(context: object | null) {
          if (context === null) return runScript(this.source, this.filename)
          return contextOf(context).run(`${this.source}\n//# sourceURL=${this.filename}`)
        }

        createCachedData() {
          return realm.newBuffer(new Uint8Array(0))
        }
      }

      const compileCommonJS = (content: string, filename: string) =>
        compileFunction(
          CJS_PARAMETERS,
          rewriteDynamicImports(content, () => realm.acorn, () => realm.importCallFor(defaultInternal, filename), 'function'),
          filename,
        )

      return {
        ContextifyScript,
        constants: { measureMemory: { mode: { SUMMARY: 0, DETAILED: 1 }, execution: { DEFAULT: 0, EAGER: 1 } } },
        compileFunctionForCJSLoader: (content: string, filename: string, _isSeaMain: boolean, shouldDetectModule: boolean) => {
          try {
            return {
              cachedDataRejected: false,
              sourceMapURL: sourceMapUrlOf(content),
              function: compileCommonJS(content, filename),
              canParseAsESM: false,
            }
          } catch (error) {
            if (shouldDetectModule && looksLikeEsm(error)) {
              return { cachedDataRejected: false, sourceMapURL: undefined, function: undefined, canParseAsESM: true }
            }
            throw error
          }
        },
        compileFunction: (
          code: string,
          filename: string,
          _line: number,
          _column: number,
          _cached: unknown,
          _produce: boolean,
          _context: unknown,
          _extensions: unknown,
          params: string[] = [],
          hostDefinedOptionId?: symbol,
        ) => {
          const body = rewriteDynamicImports(code, () => realm.acorn, () => realm.importCallFor(hostDefinedOptionId, filename), 'function')
          const fn = compileFunction(params, body, filename) as unknown as Record<symbol, unknown>
          fn[hostDefinedOption] = hostDefinedOptionId
          return { function: fn, sourceMapURL: sourceMapUrlOf(code), cachedDataRejected: false }
        },
        containsModuleSyntax: (code: string) => {
          try {
            compileFunction(CJS_PARAMETERS, code, 'containsModuleSyntax')
            return false
          } catch (error) {
            return looksLikeEsm(error)
          }
        },
        shouldRetryAsESM: (message: string) => ESM_SYNTAX_ERRORS.some((pattern) => pattern.test(message)),
        // A context is the sandbox seen through a global-scope Proxy (vmcontext.ts).
        // vm.constants.DONT_CONTEXTIFY (a symbol) asks for a fresh global object instead.
        makeContext: (sandbox: object | symbol) => {
          const object = typeof sandbox === 'object' && sandbox !== null ? sandbox : {}
          const context = createVmContext(object, () => realm.acorn)
          Object.defineProperty(object, contextSymbol, { value: context, configurable: true })
          return object === sandbox ? object : context.global
        },
        measureMemory: () => Promise.resolve({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } }),
        // The REPL's Ctrl+C watchdog interrupts a running evaluation. A Worker can't be interrupted
        // mid-script, so it only reports success; ^C still reaches the REPL between evaluations.
        startSigintWatchdog: () => true,
        stopSigintWatchdog: () => false,
        watchdogHasPendingSigint: () => false,
      }
    },

    // ES modules (src/module_wrap.cc) over transform.ts + module.ts.
    module_wrap: (realm: Realm) => {
      const hostDefinedOption = realm.privateSymbols.host_defined_option_symbol
      const importedCjs = realm.perIsolateSymbols.imported_cjs_symbol
      const records = new WeakMap<object, ModuleRecord>()
      const wraps = new WeakMap<ModuleRecord, ModuleWrap>()
      // The host-defined option identifies the loader that owns import()/import.meta for a module.
      const referrerOf = (wrap: object) => (wrap as Record<symbol, unknown>)[hostDefinedOption]
      const recordOf = (wrap: unknown): ModuleRecord => {
        const record = records.get(wrap as object)
        if (!record) throw new TypeError('Illegal invocation')
        return record
      }

      const host: ModuleHost = {
        compile: (code, url) => evaluateExpression(code, url) as (scope: ModuleScope) => Generator,
        importMeta: (record) => {
          const meta = Object.create(null) as object
          const wrap = wraps.get(record)!
          realm.initializeImportMetaCallback?.(referrerOf(wrap), meta, wrap)
          return meta
        },
        dynamicImport: (record, specifier, options) => realm.dynamicImport(referrerOf(wraps.get(record)!), specifier, options, record.url),
      }

      class ModuleWrap {
        url: string
        synthetic: boolean
        hasTopLevelAwait = false
        sourceURL: string | undefined
        sourceMapURL: string | undefined

        constructor(
          url: string,
          context: unknown,
          sourceOrExportNames: string | string[],
          lineOffsetOrSteps?: number | (() => void),
          _columnOffset?: number,
          hostDefinedOptionOrCjs?: unknown,
        ) {
          if (context !== undefined) throw new Error('vm contexts are not supported yet (webcore)')
          this.url = url
          let record: ModuleRecord
          if (Array.isArray(sourceOrExportNames)) {
            this.synthetic = true
            record = ModuleRecord.synthetic(host, url, sourceOrExportNames, lineOffsetOrSteps as () => void)
            if (hostDefinedOptionOrCjs !== null && typeof hostDefinedOptionOrCjs === 'object') {
              ;(this as Record<symbol, unknown>)[importedCjs] = hostDefinedOptionOrCjs
            }
          } else {
            this.synthetic = false
            const compiled = compileModule(realm.acorn, String(sourceOrExportNames), url)
            record = ModuleRecord.sourceText(host, url, compiled)
            this.hasTopLevelAwait = compiled.hasTopLevelAwait
            this.sourceMapURL = compiled.sourceMapURL
            ;(this as Record<symbol, unknown>)[hostDefinedOption] = hostDefinedOptionOrCjs
          }
          record.owner = this
          records.set(this, record)
          wraps.set(record, this)
        }

        get hasAsyncGraph(): boolean {
          return hasAsyncGraph(recordOf(this))
        }

        getModuleRequests() {
          return (recordOf(this).compiled?.requests ?? []).map((request) => ({ ...request, attributes: { ...request.attributes } }))
        }

        link(modules: ModuleWrap[]) {
          recordOf(this).deps = modules.map(recordOf)
        }

        instantiate() {
          instantiate(recordOf(this))
        }

        evaluate() {
          try {
            return Promise.resolve(evaluate(recordOf(this), false))
          } catch (error) {
            return Promise.reject(error)
          }
        }

        /** require(esm): synchronous, so the graph must not use top-level await. */
        evaluateSync() {
          const record = recordOf(this)
          evaluate(record, true)
          return record.namespace
        }

        getNamespace() {
          const record = recordOf(this)
          if (record.status < kInstantiated) throw new Error('cannot get namespace, module has not been instantiated')
          return record.namespace
        }

        getNamespaceSync() {
          return this.getNamespace()
        }

        getStatus() {
          return recordOf(this).status
        }

        getError() {
          return recordOf(this).error
        }

        setExport(name: string, value: unknown) {
          recordOf(this).setExport(name, value)
        }

        getModuleSourceObject() {
          throw new Error('Source phase imports are not supported (webcore)')
        }

        setModuleSourceObject() {
          throw new Error('Source phase imports are not supported (webcore)')
        }

        createCachedData() {
          return realm.newBuffer(new Uint8Array(0))
        }
      }

      return {
        ModuleWrap,
        kUninstantiated,
        kInstantiating,
        kInstantiated,
        kEvaluating,
        kEvaluated,
        kErrored,
        kSourcePhase,
        kEvaluationPhase,
        setImportModuleDynamicallyCallback: (callback: Realm['importModuleDynamicallyCallback']) => {
          realm.importModuleDynamicallyCallback = callback
        },
        setInitializeImportMetaObjectCallback: (callback: Realm['initializeImportMetaCallback']) => {
          realm.initializeImportMetaCallback = callback
        },
        /** require(esm) of a module with a default export: its namespace plus __esModule. */
        createRequiredModuleFacade: (wrap: ModuleWrap) => {
          const namespace = recordOf(wrap).namespace
          const facade = Object.create(null) as Record<PropertyKey, unknown>
          for (const name of [...Object.keys(namespace), '__esModule'].sort()) {
            Object.defineProperty(facade, name, {
              get: name === '__esModule' ? () => true : () => namespace[name],
              enumerable: true,
            })
          }
          Object.defineProperty(facade, Symbol.toStringTag, { value: 'Module' })
          return Object.preventExtensions(facade)
        },
        // Promise state isn't observable synchronously in JavaScript.
        throwIfPromiseRejected: () => {},
      }
    },

    // CommonJS export detection for `import cjs from …` (the npm package's JS lexer).
    cjs_lexer: (realm: Realm) => ({
      parse: (source: string) => {
        const lexer = realm.requireBuiltin('internal/deps/cjs-module-lexer/lexer') as {
          parse(source: string): { exports: string[]; reexports: string[] }
        }
        // [Set of export names, array of re-exported specifiers], as Node's C++ lexer returns.
        try {
          const { exports, reexports } = lexer.parse(source)
          return [new Set(exports), reexports]
        } catch {
          return [new Set(), []]
        }
      },
    }),
  }
}
