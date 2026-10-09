// Records use of C++ functionality we haven't implemented. Missing bindings are empty objects and
// missing properties read as undefined, as they would on a real binding object (lib/ relies on
// that, e.g. `binding.errmap ??= ...`). Set WEBCORE_TRACE_BINDINGS=1 to print the record at exit.

export class BindingTrace {
  readonly missing = new Map<string, number>()

  record(key: string): void {
    this.missing.set(key, (this.missing.get(key) ?? 0) + 1)
  }

  /** Wraps an implemented binding so that accesses to unimplemented properties are recorded. */
  wrap<T extends object>(name: string, binding: T): T {
    return new Proxy(binding, {
      get: (target, property, receiver) => {
        if (typeof property === 'string' && !(property in target) && property !== 'then' && property !== 'toJSON') {
          this.record(`${name}.${property}`)
        }
        return Reflect.get(target, property, receiver)
      },
    })
  }

  /** A binding with no implementation at all. */
  missingBinding(name: string): object {
    this.record(name)
    return this.wrap(name, {})
  }

  report(): string {
    const lines = [...this.missing].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, count]) => `  ${key} ×${count}`)
    return `[webcore] unimplemented bindings touched (${lines.length}):\n${lines.join('\n')}\n`
  }

}
