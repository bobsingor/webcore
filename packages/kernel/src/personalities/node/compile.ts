// Compiles source text into a function, as V8's ScriptCompiler::CompileFunction does for Node.
// The wrapper opens on the same line as the body, so stack traces report the source's own line
// numbers (`new Function` would shift them by two). Indirect eval runs at global scope.
const indirectEval = globalThis.eval

export function compileFunction(params: readonly string[], body: string, url: string): (...args: unknown[]) => unknown {
  // A hashbang is only valid at the very start of a script, so it becomes a comment here.
  const source = body.startsWith('#!') ? `//${body.slice(2)}` : body
  return indirectEval(`(function (${params.join(', ')}) {${source}\n})\n//# sourceURL=${url}`)
}

/** Evaluates a script at global scope (vm.runInThisContext). */
export function runScript(source: string, url: string): unknown {
  return indirectEval(`${source}\n//# sourceURL=${url}`)
}
