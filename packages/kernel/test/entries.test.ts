import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Code in a process Worker shares globals with the guest program (ADR-0011). A dynamic import()
// in the browser entry makes Vite's dev server inject its HMR client into every process, which
// then writes to the guest's stdout and keeps it alive with timers.
describe('process Worker entries', () => {
  for (const entry of ['worker.ts', 'worker-node.ts', 'main.ts']) {
    it(`${entry} has no dynamic import()`, () => {
      const source = readFileSync(new URL(`../src/process/${entry}`, import.meta.url), 'utf8')
      expect(source).not.toMatch(/\bimport\s*\(/)
    })
  }
})
