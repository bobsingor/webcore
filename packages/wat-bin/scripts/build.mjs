// Assembles src/*.wat into dist/*.wasm.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import initWabt from 'wabt'

const srcDir = new URL('../src/', import.meta.url)
const outDir = new URL('../dist/', import.meta.url)
const wabt = await initWabt()

await mkdir(outDir, { recursive: true })
const sources = (await readdir(srcDir)).filter((file) => file.endsWith('.wat')).sort()
for (const file of sources) {
  const module = wabt.parseWat(file, await readFile(new URL(file, srcDir), 'utf8'))
  try {
    module.validate()
    const { buffer } = module.toBinary({})
    await writeFile(new URL(file.replace(/\.wat$/, '.wasm'), outDir), buffer)
  } finally {
    module.destroy()
  }
}
console.log(`wat-bin: built ${sources.map((f) => f.replace(/\.wat$/, '')).join(', ')}`)
