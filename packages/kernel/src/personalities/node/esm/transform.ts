// ES module → two-phase generator (M1b).
//
// Browsers can't build module records from source text with custom linking, so each module is
// compiled to a generator function whose body is the module's own code, edited in place:
//
//   (function* (__wc) {"use strict";__wc.x({ name: () => local, … });yield;<module body>
//   })
//
// The first next() is instantiation: function declarations are hoisted, let/const/class are in
// their TDZ, and the export getters close over the real bindings (live bindings, cycles). The
// second next() is evaluation. Modules with top-level await become async generators.
//
// Edits are made in place so line numbers survive:
//   import declarations   → removed; references become `__wc.d[i].name` (scope-aware)
//   export declarations   → the `export` keyword is removed; names become getters
//   import.meta           → __wc.meta
//   import(x)             → __wc.import(x)

export const kSourcePhase = 1
export const kEvaluationPhase = 2

export interface ModuleRequest {
  specifier: string
  attributes: Record<string, string>
  phase: number
}

export interface CompiledModule {
  /** Source of a generator function expression taking `__wc`. */
  code: string
  requests: ModuleRequest[]
  /** Imported bindings, for link-time validation. `name` is '*' for namespace imports. */
  imports: { request: number; name: string }[]
  /** Names whose getters are registered by the prologue. */
  localExports: string[]
  /** `export { a as b } from 'x'` and `export * as ns from 'x'` ('*'). */
  indirectExports: { name: string; request: number; importName: string }[]
  starExports: number[]
  hasTopLevelAwait: boolean
  sourceMapURL: string | undefined
}

// Minimal ESTree shapes; acorn produces them.
export interface AstNode {
  type: string
  start: number
  end: number
  [key: string]: any
}

export interface Acorn {
  parse(source: string, options: object): AstNode
}

interface Edit {
  start: number
  end: number
  text: string
}

class Edits {
  private readonly list: Edit[] = []

  replace(start: number, end: number, text: string): void {
    this.list.push({ start, end, text })
  }

  insert(at: number, text: string): void {
    this.list.push({ start: at, end: at, text })
  }

  apply(source: string): string {
    const sorted = [...this.list].sort((a, b) => a.start - b.start || a.end - b.end)
    let out = ''
    let position = 0
    for (const edit of sorted) {
      if (edit.start < position) continue // overlapping edits: the first one wins
      out += source.slice(position, edit.start) + edit.text
      position = edit.end
    }
    return out + source.slice(position)
  }
}

/** Removes text but keeps its line breaks, so later lines keep their numbers. */
function blank(source: string, start: number, end: number): string {
  return source.slice(start, end).replace(/[^\n\r\u2028\u2029]/g, '')
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function nameOf(node: AstNode): string {
  return node.type === 'Identifier' ? node.name : String(node.value)
}

function member(object: string, name: string): string {
  return IDENTIFIER.test(name) ? `${object}.${name}` : `${object}[${JSON.stringify(name)}]`
}

function getterKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

/** Names bound by a binding pattern. */
export function patternNames(pattern: AstNode | null, out: string[] = []): string[] {
  if (!pattern) return out
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern.name)
      break
    case 'ObjectPattern':
      for (const property of pattern.properties) patternNames(property.type === 'RestElement' ? property.argument : property.value, out)
      break
    case 'ArrayPattern':
      for (const element of pattern.elements) patternNames(element, out)
      break
    case 'RestElement':
      patternNames(pattern.argument, out)
      break
    case 'AssignmentPattern':
      patternNames(pattern.left, out)
      break
  }
  return out
}

const isFunction = (node: AstNode) =>
  node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'

/** `var` names hoisted to the enclosing function, without entering nested functions. */
function varNames(node: AstNode | null, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out
  if (node.type === 'VariableDeclaration') {
    if (node.kind === 'var') for (const declarator of node.declarations) patternNames(declarator.id, out)
  } else if (isFunction(node) || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    return out
  }
  for (const key in node) {
    if (key === 'type' || key === 'start' || key === 'end') continue
    const value = node[key]
    if (Array.isArray(value)) for (const item of value) varNames(item, out)
    else if (value && typeof value === 'object' && typeof value.type === 'string') varNames(value, out)
  }
  return out
}

/** let/const/class/function declared directly in a statement list (block scope). */
function blockNames(statements: AstNode[]): string[] {
  const out: string[] = []
  for (const statement of statements) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement
    if (!declaration) continue
    if (declaration.type === 'VariableDeclaration' && declaration.kind !== 'var') {
      for (const declarator of declaration.declarations) patternNames(declarator.id, out)
    } else if ((declaration.type === 'ClassDeclaration' || declaration.type === 'FunctionDeclaration') && declaration.id) {
      out.push(declaration.id.name)
    }
  }
  return out
}

type Scope = { names: Set<string>; parent: Scope | null }

const scope = (parent: Scope | null, names: Iterable<string>): Scope => ({ names: new Set(names), parent })

function shadowed(name: string, current: Scope | null): boolean {
  for (let s = current; s; s = s.parent) if (s.names.has(name)) return true
  return false
}

interface WalkState {
  edits: Edits
  /** Import binding name → replacement expression. */
  imports: Map<string, string>
  meta: string
  /** Replaces `import(` (e.g. `__wc.import(`). */
  importCall: string
  topLevelAwait: boolean
}

/**
 * Rewrites references to imported bindings (respecting shadowing), import.meta and import().
 * `functionDepth` tracks whether an await is top-level.
 */
function walk(node: AstNode | null, current: Scope | null, state: WalkState, functionDepth: number, parent?: AstNode): void {
  if (!node || typeof node.type !== 'string') return
  const visit = (child: AstNode | null, s: Scope | null = current, depth = functionDepth) => walk(child, s, state, depth, node)
  const visitAll = (children: (AstNode | null)[], s: Scope | null = current, depth = functionDepth) => {
    for (const child of children) walk(child, s, state, depth, node)
  }

  switch (node.type) {
    case 'Identifier': {
      const replacement = state.imports.get(node.name)
      if (replacement !== undefined && !shadowed(node.name, current)) state.edits.replace(node.start, node.end, replacement)
      return
    }
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
      return
    case 'ExportNamedDeclaration':
      // Specifier lists are compiled into getters; only declarations contain code.
      visit(node.declaration)
      return
    case 'ExportDefaultDeclaration':
      visit(node.declaration)
      return
    case 'MetaProperty':
      if (node.meta.name === 'import') state.edits.replace(node.start, node.end, state.meta)
      return
    case 'ImportExpression':
      state.edits.replace(node.start, node.source.start, state.importCall)
      visit(node.source)
      visit(node.options ?? null)
      return
    case 'AwaitExpression':
      if (functionDepth === 0) state.topLevelAwait = true
      visit(node.argument)
      return
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const names = node.params.flatMap((param: AstNode) => patternNames(param))
      if (node.type === 'FunctionExpression' && node.id) names.push(node.id.name)
      if (node.body.type === 'BlockStatement') names.push(...varNames(node.body), ...blockNames(node.body.body))
      const inner = scope(current, names)
      for (const param of node.params) visitPattern(param, inner, state, functionDepth + 1)
      if (node.body.type === 'BlockStatement') visitAll(node.body.body, inner, functionDepth + 1)
      else visit(node.body, inner, functionDepth + 1)
      return
    }
    case 'ClassDeclaration':
    case 'ClassExpression': {
      visit(node.superClass)
      const inner = node.type === 'ClassExpression' && node.id ? scope(current, [node.id.name]) : current
      for (const element of node.body.body) {
        if (element.computed) visit(element.key, inner)
        if (element.type === 'StaticBlock') visitAll(element.body, scope(inner, blockNames(element.body)), functionDepth + 1)
        else if (element.value) visit(element.value, inner, element.type === 'PropertyDefinition' ? functionDepth + 1 : functionDepth)
      }
      return
    }
    case 'BlockStatement':
      visitAll(node.body, scope(current, blockNames(node.body)))
      return
    case 'StaticBlock':
      visitAll(node.body, scope(current, blockNames(node.body)))
      return
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      if (node.await && functionDepth === 0) state.topLevelAwait = true
      const head = node.init ?? node.left
      const inner =
        head?.type === 'VariableDeclaration' && head.kind !== 'var'
          ? scope(current, head.declarations.flatMap((declarator: AstNode) => patternNames(declarator.id)))
          : current
      if (node.type === 'ForStatement') visitAll([node.init, node.test, node.update, node.body], inner)
      else visitAll([node.left, node.right, node.body], inner)
      return
    }
    case 'SwitchStatement': {
      visit(node.discriminant)
      const inner = scope(current, blockNames(node.cases.flatMap((c: AstNode) => c.consequent)))
      for (const c of node.cases) {
        visit(c.test, inner)
        visitAll(c.consequent, inner)
      }
      return
    }
    case 'CatchClause': {
      const inner = scope(current, patternNames(node.param))
      if (node.param) visitPattern(node.param, inner, state, functionDepth)
      visitAll(node.body.body, scope(inner, blockNames(node.body.body)))
      return
    }
    case 'VariableDeclarator':
      visitPattern(node.id, current, state, functionDepth)
      visit(node.init)
      return
    case 'MemberExpression':
      visit(node.object)
      if (node.computed) visit(node.property)
      return
    case 'Property':
      if (node.computed) visit(node.key)
      if (node.shorthand && parent?.type === 'ObjectExpression' && node.value.type === 'Identifier') {
        const replacement = state.imports.get(node.value.name)
        if (replacement !== undefined && !shadowed(node.value.name, current)) {
          state.edits.replace(node.start, node.end, `${node.key.name}: ${replacement}`)
          return
        }
      }
      visit(node.value)
      return
    case 'MethodDefinition':
    case 'PropertyDefinition':
      if (node.computed) visit(node.key)
      visit(node.value)
      return
    case 'LabeledStatement':
      visit(node.body)
      return
    case 'BreakStatement':
    case 'ContinueStatement':
      return
  }

  for (const key in node) {
    if (key === 'type' || key === 'start' || key === 'end') continue
    const value = node[key]
    if (Array.isArray(value)) visitAll(value)
    else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value)
  }
}

/** Binding patterns: names are declarations, but defaults and computed keys are code. */
function visitPattern(pattern: AstNode | null, current: Scope | null, state: WalkState, depth: number): void {
  if (!pattern) return
  switch (pattern.type) {
    case 'Identifier':
      return
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') visitPattern(property.argument, current, state, depth)
        else {
          if (property.computed) walk(property.key, current, state, depth)
          visitPattern(property.value, current, state, depth)
        }
      }
      return
    case 'ArrayPattern':
      for (const element of pattern.elements) visitPattern(element, current, state, depth)
      return
    case 'RestElement':
      visitPattern(pattern.argument, current, state, depth)
      return
    case 'AssignmentPattern':
      visitPattern(pattern.left, current, state, depth)
      walk(pattern.right, current, state, depth)
      return
    default:
      // Assignment targets in destructuring assignments (member expressions etc.).
      walk(pattern, current, state, depth)
  }
}

export function sourceMapUrlOf(source: string): string | undefined {
  return /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(source)?.[1]
}

/** Converts an acorn parse error into a SyntaxError shaped like V8's: location, source line, caret. */
function syntaxError(error: unknown, source: string, url: string): SyntaxError {
  const { message = String(error), loc } = error as { message?: string; loc?: { line: number; column: number } }
  const result = new SyntaxError(message.replace(/ \(\d+:\d+\)$/, ''))
  if (loc) {
    const line = source.split(/\r\n|[\n\r\u2028\u2029]/)[loc.line - 1] ?? ''
    const arrow = `${url}:${loc.line}\n${line}\n${' '.repeat(loc.column)}^\n`
    result.stack = `${arrow}\n${result.name}: ${result.message}\n    at ${url}:${loc.line}:${loc.column + 1}`
  }
  return result
}

export function compileModule(acorn: Acorn, source: string, url: string): CompiledModule {
  let ast: AstNode
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
  } catch (error) {
    throw syntaxError(error, source, url)
  }

  const edits = new Edits()
  const requests: ModuleRequest[] = []
  const imports = new Map<string, string>()
  const importList: CompiledModule['imports'] = []
  const getters: [name: string, expression: string][] = []
  const indirectExports: CompiledModule['indirectExports'] = []
  const starExports: number[] = []
  const prologue: string[] = []

  const request = (node: AstNode): number => {
    const specifier = String(node.source.value)
    const attributes: Record<string, string> = {}
    for (const attribute of node.attributes ?? []) attributes[nameOf(attribute.key)] = String(attribute.value.value)
    const key = JSON.stringify([specifier, attributes])
    const existing = requests.findIndex((r) => JSON.stringify([r.specifier, r.attributes]) === key)
    if (existing >= 0) return existing
    requests.push({ specifier, attributes, phase: node.phase === 'source' ? kSourcePhase : kEvaluationPhase })
    return requests.length - 1
  }

  if (source.startsWith('#!')) edits.replace(0, 2, '//')

  // First pass: module requests and import bindings (getters below may refer to imports).
  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration') continue
    const index = request(statement)
    for (const specifier of statement.specifiers) {
      const local = specifier.local.name
      const target = `__wc.d[${index}]`
      if (specifier.type === 'ImportNamespaceSpecifier') {
        imports.set(local, target)
        importList.push({ request: index, name: '*' })
      } else {
        const imported = specifier.type === 'ImportDefaultSpecifier' ? 'default' : nameOf(specifier.imported)
        imports.set(local, member(target, imported))
        importList.push({ request: index, name: imported })
      }
    }
    edits.replace(statement.start, statement.end, blank(source, statement.start, statement.end))
  }

  const exportLocal = (name: string, local: string) => getters.push([name, imports.get(local) ?? local])

  for (const statement of ast.body) {
    switch (statement.type) {
      case 'ExportNamedDeclaration': {
        if (statement.declaration) {
          // `export` keyword out; the declaration stays.
          edits.replace(statement.start, statement.declaration.start, '')
          const declaration = statement.declaration
          const names =
            declaration.type === 'VariableDeclaration'
              ? declaration.declarations.flatMap((declarator: AstNode) => patternNames(declarator.id))
              : [declaration.id.name]
          for (const name of names) exportLocal(name, name)
        } else if (statement.source) {
          const index = request(statement)
          for (const specifier of statement.specifiers) {
            indirectExports.push({ name: nameOf(specifier.exported), request: index, importName: nameOf(specifier.local) })
          }
          edits.replace(statement.start, statement.end, blank(source, statement.start, statement.end))
        } else {
          for (const specifier of statement.specifiers) exportLocal(nameOf(specifier.exported), nameOf(specifier.local))
          edits.replace(statement.start, statement.end, blank(source, statement.start, statement.end))
        }
        break
      }
      case 'ExportDefaultDeclaration': {
        const declaration = statement.declaration
        const named = (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id
        if (named) {
          edits.replace(statement.start, declaration.start, '')
          exportLocal('default', declaration.id.name)
        } else if (declaration.type === 'FunctionDeclaration') {
          // An anonymous default function is still a hoisted declaration: give it a name.
          edits.replace(statement.start, declaration.start, '')
          const keyword = /^(async\s+)?function\s*\*?/.exec(source.slice(declaration.start))![0]
          edits.insert(declaration.start + keyword.length, ' __wc_default')
          prologue.push('Object.defineProperty(__wc_default, "name", { value: "default" });')
          getters.push(['default', '__wc_default'])
        } else {
          // An expression: anonymous functions and classes are named "default".
          const anonymous =
            ((declaration.type === 'FunctionExpression' || declaration.type === 'ClassExpression') && !declaration.id) ||
            declaration.type === 'ArrowFunctionExpression' ||
            declaration.type === 'ClassDeclaration'
          edits.replace(statement.start, declaration.start, anonymous ? 'const __wc_default = ({ default: ' : 'const __wc_default = (')
          edits.insert(declaration.end, anonymous ? ' }).default' : ')')
          getters.push(['default', '__wc_default'])
        }
        break
      }
      case 'ExportAllDeclaration': {
        const index = request(statement)
        if (statement.exported) indirectExports.push({ name: nameOf(statement.exported), request: index, importName: '*' })
        else starExports.push(index)
        edits.replace(statement.start, statement.end, blank(source, statement.start, statement.end))
        break
      }
    }
  }

  const state: WalkState = { edits, imports, meta: '__wc.meta', importCall: '__wc.import(', topLevelAwait: false }
  walk(ast, null, state, 0)

  const exportObject = getters.map(([name, expression]) => `${getterKey(name)}: () => ${expression}`).join(', ')
  const head = `(${state.topLevelAwait ? 'async ' : ''}function* (__wc) {"use strict";__wc.x({ ${exportObject} });${prologue.join('')}yield;`
  return {
    code: `${head}${edits.apply(source)}\n})`,
    requests,
    imports: importList,
    localExports: getters.map(([name]) => name),
    indirectExports,
    starExports,
    hasTopLevelAwait: state.topLevelAwait,
    sourceMapURL: sourceMapUrlOf(source),
  }
}

/**
 * Rewrites dynamic import() in scripts and CommonJS: `import(` becomes `replacement` (which
 * opens a call), so it reaches Node's loader. Cheap when the source has no `import(` at all,
 * which is the common case.
 */
export function rewriteDynamicImports(
  source: string,
  acorn: () => Acorn,
  replacementFor: () => string,
  kind: 'script' | 'function',
): string {
  if (!/\bimport\s*\(/.test(source)) return source
  let ast: AstNode
  try {
    ast = acorn().parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: true,
      allowReturnOutsideFunction: kind === 'function',
      allowAwaitOutsideFunction: kind === 'script',
    })
  } catch {
    return source // Let the engine report the syntax error.
  }
  const edits = new Edits()
  let replacement: string | undefined
  const visit = (node: AstNode | null) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'ImportExpression') edits.replace(node.start, node.source.start, (replacement ??= replacementFor()))
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const value = node[key]
      if (Array.isArray(value)) for (const item of value) visit(item)
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value)
    }
  }
  visit(ast)
  return edits.apply(source)
}
