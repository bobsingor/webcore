// Compiles source text into a function, as V8's ScriptCompiler::CompileFunction does for Node.
// The wrapper opens on the same line as the body, so stack traces report the source's own line
// numbers (`new Function` would shift them by two). Indirect eval runs at global scope.
const indirectEval = globalThis.eval

/** Every script URL we compiled: frames from anywhere else belong to webcore itself. */
export const compiledScripts = new Set<string>()

export function compileFunction(params: readonly string[], body: string, url: string): (...args: unknown[]) => unknown {
  // A hashbang is only valid at the very start of a script, so it becomes a comment here.
  const source = body.startsWith('#!') ? `//${body.slice(2)}` : body
  compiledScripts.add(url)
  return indirectEval(`(function (${params.join(', ')}) {${source}\n})\n//# sourceURL=${url}`)
}

/** Evaluates a script at global scope (vm.runInThisContext). */
export function runScript(source: string, url: string): unknown {
  compiledScripts.add(url)
  return indirectEval(`${source}\n//# sourceURL=${url}`)
}

/** Evaluates a function expression's source (e.g. a compiled ES module) as-is. */
export function evaluateExpression(source: string, url: string): unknown {
  compiledScripts.add(url)
  return indirectEval(`${source}\n//# sourceURL=${url}`)
}
