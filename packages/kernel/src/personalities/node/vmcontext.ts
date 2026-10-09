// vm contexts without new realms (M2a). A Worker can't create a JavaScript realm, so a context is
// its sandbox object seen through a Proxy that acts as the global scope of code run in it. Names
// resolve to the sandbox, then to the context's builtins (Object, Array, JSON, …), and never to
// the process's own globals (process, require, Buffer). Top-level `var` declarations land on the
// sandbox, and function declarations are copied there after each run, as V8 puts both on the
// context's global object.
//
// Known differences from real contexts: builtins are the main context's (so instanceof works
// across contexts), undeclared names read as undefined instead of throwing, and top-level
// let/const don't persist from one run to the next.
import type { Acorn, AstNode } from './esm/transform.ts'

/** The globals a fresh V8 context has: ECMAScript's, plus V8's console and WebAssembly. */
const CONTEXT_GLOBALS = [
  'Object', 'Function', 'Array', 'Number', 'parseFloat', 'parseInt', 'Infinity', 'NaN', 'undefined',
  'Boolean', 'String', 'Symbol', 'Date', 'Promise', 'RegExp', 'Error', 'AggregateError', 'EvalError',
  'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'SuppressedError', 'globalThis',
  'JSON', 'Math', 'Intl', 'ArrayBuffer', 'Atomics', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array',
  'Uint32Array', 'Int32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray',
  'BigUint64Array', 'BigInt64Array', 'DataView', 'Map', 'BigInt', 'Set', 'WeakMap', 'WeakSet', 'Proxy',
  'Reflect', 'FinalizationRegistry', 'WeakRef', 'decodeURI', 'decodeURIComponent', 'encodeURI',
  'encodeURIComponent', 'escape', 'unescape', 'eval', 'isFinite', 'isNaN', 'console', 'SharedArrayBuffer',
  'WebAssembly', 'Iterator', 'DisposableStack', 'AsyncDisposableStack',
]

export interface VmContext {
  readonly sandbox: object
  /** The context's global object, as code inside sees it (globalThis, this). */
  readonly global: object
  run(code: string): unknown
}

export function createVmContext(sandbox: object, acorn: () => Acorn): VmContext {
  const host = globalThis as unknown as Record<string, unknown>
  const builtins = new Set(CONTEXT_GLOBALS.filter((name) => name in host))
  /** Top-level `var` names of the code being run: they belong to the sandbox. */
  let declared = new Set<string>()

  const global: object = new Proxy(sandbox, {
    has: (target, key) => typeof key === 'string' && (key in target || builtins.has(key) || declared.has(key)),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined
      if (key in target) return Reflect.get(target, key)
      if (key === 'globalThis') return global
      return typeof key === 'string' && builtins.has(key) ? host[key] : undefined
    },
    set: (target, key, value) => Reflect.set(target, key, value),
    ownKeys: (target) => [...new Set([...Reflect.ownKeys(target), ...builtins])],
    getOwnPropertyDescriptor: (target, key) => {
      const own = Reflect.getOwnPropertyDescriptor(target, key)
      if (own || typeof key !== 'string' || !builtins.has(key)) return own
      return { value: key === 'globalThis' ? global : host[key], writable: true, enumerable: false, configurable: true }
    },
  })

  return {
    sandbox,
    global,
    run(code: string) {
      const { vars, functions } = topLevelNames(acorn, code)
      declared = vars
      try {
        return evaluate.call(global, global, code, [...functions])
      } finally {
        declared = new Set()
      }
    },
  }
}

// Outside the evaluating function, every remaining name resolves to undefined: the process's
// globals stay out of reach. Only `eval` passes, for the function's own use.
const shadow = new Proxy(Object.create(null) as object, {
  has: (_, key) => key !== 'eval',
  get: () => undefined,
})

// Runs `code` as direct eval code inside `with (scope)`. Its hoisted function declarations live in
// this function's scope; afterwards they're copied onto the scope (the sandbox).
const evaluate = new Function(
  '__webcoreShadow',
  `with (__webcoreShadow) {
    return function (__webcoreScope, __webcoreCode, __webcoreFunctions) {
      var __webcoreResult
      with (__webcoreScope) { __webcoreResult = eval(__webcoreCode) }
      for (var __webcoreName of __webcoreFunctions) __webcoreScope[__webcoreName] = eval(__webcoreName)
      return __webcoreResult
    }
  }`,
)(shadow) as (this: object, scope: object, code: string, functions: string[]) => unknown

/** Names a script declares at its top level: `var`s (in any block) and function declarations. */
function topLevelNames(acorn: () => Acorn, code: string): { vars: Set<string>; functions: Set<string> } {
  const vars = new Set<string>()
  const functions = new Set<string>()
  let ast: AstNode
  try {
    ast = acorn().parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true })
  } catch {
    // eval reports the syntax error.
    return { vars, functions }
  }
  const names = (pattern: AstNode | null, into: Set<string>): void => {
    if (!pattern) return
    if (pattern.type === 'Identifier') into.add(pattern.name as string)
    else if (pattern.type === 'ObjectPattern') for (const property of pattern.properties as AstNode[]) names((property.value ?? property.argument) as AstNode, into)
    else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements as (AstNode | null)[]) names(element, into)
    else if (pattern.type === 'RestElement') names(pattern.argument as AstNode, into)
    else if (pattern.type === 'AssignmentPattern') names(pattern.left as AstNode, into)
  }
  const visit = (node: AstNode | null, top: boolean): void => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'FunctionDeclaration') {
      if (top && node.id) functions.add((node.id as AstNode).name as string)
      return
    }
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      for (const declarator of node.declarations as AstNode[]) names(declarator.id as AstNode, vars)
    }
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const value = node[key]
      if (Array.isArray(value)) for (const item of value) visit(item as AstNode, top && node.type === 'Program')
      else if (value && typeof value === 'object' && typeof (value as AstNode).type === 'string') visit(value as AstNode, false)
    }
  }
  visit(ast, true)
  return { vars, functions }
}
