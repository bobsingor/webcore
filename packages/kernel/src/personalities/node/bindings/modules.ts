// contextify (compiling CommonJS and vm scripts), module_wrap and cjs_lexer (ES modules, M1b).
import { compileFunction, runScript } from '../compile.ts'
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

function sourceMapUrl(source: string): string | undefined {
  return /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(source)?.[1]
}

export function moduleBindings() {
  return {
    contextify: (realm: Realm) => {
      const hostDefinedOption = realm.privateSymbols.host_defined_option_symbol
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
          this.source = code
          this.filename = filename
          this.sourceMapURL = sourceMapUrl(code)
          // Identifies the dynamic-import callback registry for this script (src/node_contextify.cc).
          ;(this as Record<symbol, unknown>)[hostDefinedOption] = hostDefinedOptionId
          // Compile eagerly so syntax errors surface at construction, as with V8.
          compileFunction([], code, filename)
        }

        runInThisContext() {
          return runScript(this.source, this.filename)
        }

        /** A null context means the current one (vm.runInThisContext). */
        runInContext(context: object | null) {
          if (context === null) return runScript(this.source, this.filename)
          throw new Error('vm contexts are not supported yet (webcore)')
        }

        createCachedData() {
          return realm.newBuffer(new Uint8Array(0))
        }
      }

      return {
        ContextifyScript,
        constants: { measureMemory: { mode: { SUMMARY: 0, DETAILED: 1 }, execution: { DEFAULT: 0, EAGER: 1 } } },
        compileFunctionForCJSLoader: (content: string, filename: string, _isSeaMain: boolean, shouldDetectModule: boolean) => {
          try {
            return {
              cachedDataRejected: false,
              sourceMapURL: sourceMapUrl(content),
              function: compileFunction(CJS_PARAMETERS, content, filename),
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
          const fn = compileFunction(params, code, filename) as unknown as Record<symbol, unknown>
          fn[hostDefinedOption] = hostDefinedOptionId
          return { function: fn, sourceMapURL: sourceMapUrl(code), cachedDataRejected: false }
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
        makeContext: () => {
          throw new Error('vm contexts are not supported yet (webcore)')
        },
        measureMemory: () => Promise.resolve({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } }),
        startSigintWatchdog: () => {},
        stopSigintWatchdog: () => false,
        watchdogHasPendingSigint: () => false,
      }
    },

    // ES modules arrive in M1b. ModuleWrap must exist as a class for the realm bootstrap.
    module_wrap: () => ({
      ModuleWrap: class ModuleWrap {
        constructor() {
          throw new Error('ES modules are not supported yet (webcore M1b)')
        }
      },
      kUninstantiated: 0,
      kInstantiating: 1,
      kInstantiated: 2,
      kEvaluating: 3,
      kEvaluated: 4,
      kErrored: 5,
      kSourcePhase: 1,
      kEvaluationPhase: 2,
      setImportModuleDynamicallyCallback: () => {},
      setInitializeImportMetaObjectCallback: () => {},
      createRequiredModuleFacade: () => {
        throw new Error('ES modules are not supported yet (webcore M1b)')
      },
      throwIfPromiseRejected: () => {},
    }),
  }
}
