// webcore's npm: a package installer and script runner with npm's command line, layout and
// lockfile (ADR-0015). It's not the npm CLI. It installs from the registry with the kernel's help,
// skips dependencies' install scripts, and doesn't publish.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { lockfileFor, treeFromLockfile, type Lockfile } from './lockfile.ts'
import { reify } from './reify.ts'
import { loadConfig, NpmError, parseArgSpec, pickVersion, Registry, type Manifest, type Spec } from './registry.ts'
import { satisfies } from './semver.ts'
import { TreeBuilder, type Node } from './tree.ts'

export const VERSION = '11.6.2'

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const
type Section = (typeof SECTIONS)[number]

interface Flags {
  saveDev: boolean
  saveOptional: boolean
  saveExact: boolean
  noSave: boolean
  ignoreScripts: boolean
  silent: boolean
  yes: boolean
  ifPresent: boolean
  global: boolean
  packages: string[]
}

// --- output ----------------------------------------------------------------------------------

let silent = false

function log(message: string): void {
  if (!silent) process.stdout.write(`${message}\n`)
}

function warn(message: string): void {
  if (!silent) process.stderr.write(`npm warn ${message}\n`)
}

function error(message: string): void {
  process.stderr.write(`${message.split('\n').map((line) => `npm error ${line}`).join('\n')}\n`)
}

function elapsed(started: number): string {
  const ms = performance.now() - started
  return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

// --- package.json ----------------------------------------------------------------------------

/** The nearest directory with a package.json, like npm's local prefix; else `cwd`. */
function findPrefix(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir
    if (dir === dirname(dir)) return cwd
  }
}

interface PackageFile {
  manifest: Manifest & { scripts?: Record<string, string>; [key: string]: unknown }
  indent: string
  newline: string
}

function readPackage(prefix: string): PackageFile | undefined {
  let text: string
  try {
    text = readFileSync(join(prefix, 'package.json'), 'utf8')
  } catch {
    return undefined
  }
  try {
    return {
      manifest: JSON.parse(text),
      indent: /^[ \t]+/m.exec(text)?.[0] ?? '  ',
      newline: text.includes('\r\n') ? '\r\n' : '\n',
    }
  } catch (cause) {
    throw new NpmError('EJSONPARSE', `Invalid package.json in ${prefix}: ${(cause as Error).message}`)
  }
}

function writePackage(prefix: string, file: PackageFile): void {
  const text = JSON.stringify(file.manifest, null, file.indent).replace(/\n/g, file.newline)
  writeFileSync(join(prefix, 'package.json'), `${text}${file.newline}`)
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

// --- environment for scripts and bins --------------------------------------------------------

function userAgent(): string {
  return `npm/${VERSION} node/${process.version} ${process.platform} ${process.arch} workspaces/false`
}

/** PATH with node_modules/.bin of the project and each ancestor first, as npm sets it. */
function scriptPath(prefix: string, extra: string[] = []): string {
  const bins: string[] = [...extra]
  for (let dir = prefix; ; dir = dirname(dir)) {
    bins.push(join(dir, 'node_modules', '.bin'))
    if (dir === dirname(dir)) break
  }
  return [...bins, process.env.PATH ?? '/usr/bin:/bin'].join(':')
}

function npmEnv(prefix: string, manifest?: Manifest, extraBins: string[] = []): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  env.PATH = scriptPath(prefix, extraBins)
  env.npm_config_user_agent = userAgent()
  env.npm_execpath = '/usr/lib/webcore/npm/bin/npm.js'
  env.npm_node_execpath = process.execPath
  env.NODE = process.execPath
  env.INIT_CWD = process.env.INIT_CWD ?? process.cwd()
  if (manifest) {
    env.npm_package_json = join(prefix, 'package.json')
    if (manifest.name) env.npm_package_name = manifest.name
    if (manifest.version) env.npm_package_version = manifest.version
  }
  return env
}

/** Quotes an argument for sh. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

function onPath(command: string, path = ''): boolean {
  if (command.includes('/')) return existsSync(command)
  return path.split(':').some((dir) => dir && existsSync(join(dir, command)))
}

/** Runs a command and resolves with its exit status (128 + n when killed by signal n). */
function run(command: string, args: string[], options: { cwd: string; env: Record<string, string>; shell?: boolean }): Promise<number> {
  return new Promise((resolvePromise) => {
    // Plain commands that name an executable skip the shell, which saves starting a process.
    const direct = !options.shell || (!/[|&;<>()$`\\"'*?[\]#~=%{}\n]/.test(command) && onPath(command.split(/\s+/)[0], options.env.PATH))
    const child = direct
      ? spawn(command.split(/\s+/)[0], [...command.split(/\s+/).slice(1).filter(Boolean), ...args], { cwd: options.cwd, env: options.env, stdio: 'inherit' })
      : spawn('/bin/sh', ['-c', [command, ...args.map(quote)].join(' ')], { cwd: options.cwd, env: options.env, stdio: 'inherit' })
    child.on('error', (cause: NodeJS.ErrnoException) => {
      process.stderr.write(`sh: ${command.split(/\s+/)[0]}: ${cause.code === 'ENOENT' ? 'not found' : cause.message}\n`)
      resolvePromise(cause.code === 'ENOENT' ? 127 : 126)
    })
    child.on('exit', (code, signal) => resolvePromise(code ?? 128 + (signal ? ({ SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal] ?? 1 : 1)))
  })
}

// --- install ---------------------------------------------------------------------------------

async function install(prefix: string, flags: Flags, options: { ci?: boolean; quiet?: boolean } = {}): Promise<number> {
  const started = performance.now()
  let file = readPackage(prefix)
  if (!file) {
    if (!flags.packages.length) {
      error(`code ENOENT\nCould not read package.json: ${join(prefix, 'package.json')}`)
      return 254
    }
    file = { manifest: {} as PackageFile['manifest'], indent: '  ', newline: '\n' }
  }
  const registry = new Registry(loadConfig(prefix))

  // `npm install <spec>…` adds to package.json first.
  if (flags.packages.length) {
    const section: Section = flags.saveDev ? 'devDependencies' : flags.saveOptional ? 'optionalDependencies' : 'dependencies'
    for (const arg of flags.packages) {
      const { alias, spec, raw } = parseArgSpec(arg)
      const saved = await specToSave(registry, spec, raw, flags.saveExact)
      const value = alias !== spec.name && spec.type !== 'tarball' ? `npm:${spec.name}@${saved}` : saved
      if (flags.noSave) continue
      for (const other of SECTIONS) if (other !== section && file.manifest[other]) delete file.manifest[other]![alias]
      file.manifest[section] = sortKeys({ ...file.manifest[section], [alias]: value })
    }
    if (flags.noSave) {
      // Still install them: as dependencies of a throwaway manifest.
      for (const arg of flags.packages) {
        const { alias, raw } = parseArgSpec(arg)
        file.manifest.dependencies = { ...file.manifest.dependencies, [alias]: raw || 'latest' }
      }
    }
  }

  const manifest = file.manifest
  const lockPath = join(prefix, 'package-lock.json')
  let lock: Lockfile | undefined
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    lock = undefined
  }
  let tree: Node | undefined = lock && !flags.packages.length ? treeFromLockfile(lock, manifest) : undefined
  if (options.ci && !tree) {
    error(
      lock
        ? 'code EUSAGE\n`npm ci` can only install packages when your package.json and package-lock.json are in sync.'
        : 'code EUSAGE\nThe `npm ci` command can only install with an existing package-lock.json.',
    )
    return 1
  }
  tree ??= await new TreeBuilder(registry, { warn, prefetchTarballs: true }).build(manifest)

  if (!flags.ignoreScripts) {
    const status = await lifecycle(prefix, manifest, ['preinstall'])
    if (status) return status
  }
  const result = await reify(tree, prefix, registry)
  if (flags.packages.length && !flags.noSave) writePackage(prefix, file)
  if (!flags.noSave) writeFileSync(lockPath, `${JSON.stringify(lockfileFor(tree, manifest), null, 2)}\n`)
  if (!flags.ignoreScripts) {
    const status = await lifecycle(prefix, manifest, ['install', 'postinstall', 'preprepare', 'prepare', 'postprepare'])
    if (status) return status
  }

  if (result.scripts.length) {
    warn(`skipped install scripts of ${plural(result.scripts.length, 'package')} (not supported yet): ${result.scripts.join(', ')}`)
  }
  if (!options.quiet) {
    const parts = [
      result.added && `added ${plural(result.added, 'package')}`,
      result.removed && `removed ${plural(result.removed, 'package')}`,
      result.changed && `changed ${plural(result.changed, 'package')}`,
    ].filter(Boolean)
    log(parts.length ? `\n${parts.join(', ')} in ${elapsed(started)}` : `\nup to date in ${elapsed(started)}`)
  }
  return 0
}

/** What `npm install <spec>` records: ^version by default. */
async function specToSave(registry: Registry, spec: Spec, raw: string, exact: boolean): Promise<string> {
  if (spec.type === 'tarball') return spec.url
  const manifest = pickVersion(await registry.packument(spec.name), spec)
  if (!manifest) throw new NpmError('ETARGET', `No matching version found for ${spec.name}@${raw || 'latest'}.`)
  if (spec.type === 'range' && raw && !/^\d/.test(raw)) return raw
  return exact ? manifest.version : `^${manifest.version}`
}

async function uninstall(prefix: string, flags: Flags): Promise<number> {
  const file = readPackage(prefix)
  if (!file) {
    error(`code ENOENT\nCould not read package.json: ${join(prefix, 'package.json')}`)
    return 254
  }
  for (const name of flags.packages) for (const section of SECTIONS) if (file.manifest[section]) delete file.manifest[section]![name]
  writePackage(prefix, file)
  return install(prefix, { ...flags, packages: [] })
}

async function lifecycle(prefix: string, manifest: PackageFile['manifest'], events: string[]): Promise<number> {
  for (const event of events) {
    const script = manifest.scripts?.[event]
    if (!script) continue
    log(`\n> ${manifest.name ?? ''}@${manifest.version ?? ''} ${event}\n> ${script}\n`)
    const env = { ...npmEnv(prefix, manifest), npm_lifecycle_event: event, npm_lifecycle_script: script }
    const status = await run(script, [], { cwd: prefix, env, shell: true })
    if (status) return status
  }
  return 0
}

// --- run -------------------------------------------------------------------------------------

async function runScript(prefix: string, name: string | undefined, args: string[], flags: Flags): Promise<number> {
  const file = readPackage(prefix)
  if (!file) {
    error(`code ENOENT\nCould not read package.json: ${join(prefix, 'package.json')}`)
    return 254
  }
  const { manifest } = file
  const scripts = manifest.scripts ?? {}
  if (!name) {
    const entries = Object.entries(scripts)
    if (entries.length) {
      log(`Scripts available in ${manifest.name ?? ''}@${manifest.version ?? ''} via \`npm run-script\`:`)
      for (const [script, command] of entries) log(`  ${script}\n    ${command}`)
    }
    return 0
  }
  const script = scripts[name] ?? (name === 'start' && existsSync(join(prefix, 'server.js')) ? 'node server.js' : undefined)
  if (!script) {
    if (flags.ifPresent) return 0
    error(`Missing script: "${name}"\n\nTo see a list of scripts, run:\n  npm run`)
    return 1
  }
  for (const [event, command, extra] of [
    [`pre${name}`, scripts[`pre${name}`], []],
    [name, script, args],
    [`post${name}`, scripts[`post${name}`], []],
  ] as [string, string | undefined, string[]][]) {
    if (!command) continue
    log(`\n> ${manifest.name ?? ''}@${manifest.version ?? ''} ${event}\n> ${[command, ...extra.map(quote)].join(' ')}\n`)
    const env = { ...npmEnv(prefix, manifest), npm_lifecycle_event: event, npm_lifecycle_script: command, npm_command: 'run-script' }
    const status = await run(command, extra, { cwd: prefix, env, shell: true })
    if (status) {
      if (status < 128) error(`Lifecycle script \`${event}\` failed with error:\ncode ${status}\npath ${prefix}\ncommand failed\ncommand sh -c ${command}`)
      return status
    }
  }
  return 0
}

// --- exec / npx / create ---------------------------------------------------------------------

function findLocalBin(cwd: string, name: string): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', '.bin', name)
    if (existsSync(candidate)) return candidate
    if (dir === dirname(dir)) return undefined
  }
}

function hash(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193)
    h2 = Math.imul(h2 ^ text.charCodeAt(i), 0x5bd1e995)
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

/** Which bin `npx <pkg>` runs: the only one, or the one named after the package. */
function pickBin(manifest: Manifest, name: string): string | undefined {
  const bin = manifest.bin
  if (!bin) return undefined
  if (typeof bin === 'string') return name.replace(/^@[^/]+\//, '')
  const names = Object.keys(bin)
  if (names.length === 1) return names[0]
  const unscoped = name.replace(/^@[^/]+\//, '')
  return names.includes(unscoped) ? unscoped : undefined
}

async function exec(cwd: string, specArg: string | undefined, args: string[], flags: Flags): Promise<number> {
  const prefix = findPrefix(cwd)
  const packages = flags.packages.length ? flags.packages : specArg ? [specArg] : []
  if (!packages.length) {
    error('code EUSAGE\nnpx/npm exec needs a package or command to run')
    return 1
  }
  const command = flags.packages.length ? specArg : undefined

  // A bare command that's already installed runs from node_modules/.bin.
  if (!flags.packages.length && specArg && !specArg.includes('@', 1) && !specArg.startsWith('.')) {
    const local = findLocalBin(cwd, specArg)
    if (local) return run(local, args, { cwd, env: npmEnv(prefix, readPackage(prefix)?.manifest) })
  }

  // Otherwise install the packages into npx's cache and run a bin from there.
  const registry = new Registry(loadConfig(prefix))
  const dependencies: Record<string, string> = {}
  const versions: string[] = []
  for (const arg of packages) {
    const { alias, spec } = parseArgSpec(arg)
    const manifest = spec.type === 'tarball' ? undefined : pickVersion(await registry.packument(spec.name), spec)
    if (spec.type !== 'tarball' && !manifest) throw new NpmError('ETARGET', `No matching version found for ${arg}.`)
    dependencies[alias] = spec.type === 'tarball' ? spec.url : alias !== spec.name ? `npm:${spec.name}@${manifest!.version}` : manifest!.version
    versions.push(`${alias}@${manifest?.version ?? spec.type}`)
  }
  const dir = join(homedir(), '.npm', '_npx', hash(JSON.stringify(dependencies)))
  const ready = Object.entries(dependencies).every(([name, version]) => {
    try {
      const installed = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')) as Manifest
      return installed.version === version || satisfies(installed.version, version)
    } catch {
      return false
    }
  })
  if (!ready) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies }, null, 2))
    if (!silent) process.stderr.write(`npm warn exec The following package${versions.length === 1 ? ' was' : 's were'} not found and will be installed: ${versions.join(', ')}\n`)
    const status = await install(dir, { ...flags, packages: [], ignoreScripts: true, noSave: false }, { quiet: true })
    if (status) return status
  }
  const first = Object.keys(dependencies)[0]
  let bin = command
  if (!bin) {
    const manifest = JSON.parse(readFileSync(join(dir, 'node_modules', first, 'package.json'), 'utf8')) as Manifest
    bin = pickBin(manifest, first)
    if (!bin) {
      error('could not determine executable to run')
      return 1
    }
  }
  const binPath = join(dir, 'node_modules', '.bin', bin)
  if (!existsSync(binPath) && !command) {
    error(`could not determine executable to run`)
    return 1
  }
  const env = npmEnv(prefix, readPackage(prefix)?.manifest, [join(dir, 'node_modules', '.bin')])
  return run(existsSync(binPath) ? binPath : bin, args, { cwd, env })
}

/** `npm init <initializer>` → `npm exec create-<initializer>`, as npm maps the names. */
function initializerPackage(initializer: string): string {
  const { alias, raw } = parseArgSpec(initializer)
  const version = raw ? `@${raw}` : ''
  if (alias.startsWith('@')) {
    const [scope, name] = alias.split('/')
    return name ? `${scope}/create-${name}${version}` : `${scope}/create${version}`
  }
  return `create-${alias}${version}`
}

function initDefault(cwd: string): number {
  const path = join(cwd, 'package.json')
  if (existsSync(path)) {
    log(`Wrote to ${path}: (unchanged)`)
    return 0
  }
  const manifest = {
    name: basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
    version: '1.0.0',
    description: '',
    main: 'index.js',
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
    keywords: [],
    author: '',
    license: 'ISC',
  }
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(path, text)
  log(`Wrote to ${path}:\n\n${text}`)
  return 0
}

// --- command line ----------------------------------------------------------------------------

const ALIASES: Record<string, string> = {
  i: 'install', in: 'install', ins: 'install', inst: 'install', insta: 'install', instal: 'install', isnt: 'install', isntall: 'install', add: 'install',
  ci: 'ci', 'clean-install': 'ci', 'install-clean': 'ci', ic: 'ci',
  un: 'uninstall', unlink: 'uninstall', remove: 'uninstall', rm: 'uninstall', r: 'uninstall',
  'run-script': 'run', rum: 'run', urn: 'run',
  t: 'test', tst: 'test',
  x: 'exec',
  innit: 'init', create: 'init',
}

function parseFlags(args: string[], stopAtFirstPositional: boolean): { flags: Flags; positionals: string[]; rest: string[] } {
  const flags: Flags = {
    saveDev: false, saveOptional: false, saveExact: false, noSave: false, ignoreScripts: false, silent: false, yes: false, ifPresent: false,
    global: false, packages: [],
  }
  const positionals: string[] = []
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      i++
      break
    }
    if (stopAtFirstPositional && positionals.length && !arg.startsWith('-')) break
    if (!arg.startsWith('-')) {
      positionals.push(arg)
      if (stopAtFirstPositional) {
        i++
        break
      }
      continue
    }
    const [key, value] = arg.split('=', 2)
    switch (key) {
      case '-D':
      case '--save-dev':
        flags.saveDev = true
        break
      case '-O':
      case '--save-optional':
        flags.saveOptional = true
        break
      case '-E':
      case '--save-exact':
        flags.saveExact = true
        break
      case '--no-save':
        flags.noSave = true
        break
      case '--ignore-scripts':
        flags.ignoreScripts = true
        break
      case '-s':
      case '--silent':
      case '--quiet':
      case '-q':
        flags.silent = true
        break
      case '-y':
      case '--yes':
        flags.yes = true
        break
      case '--if-present':
        flags.ifPresent = true
        break
      case '-g':
      case '--global':
        flags.global = true
        break
      case '-p':
      case '--package':
        flags.packages.push(value ?? args[++i])
        break
      case '--registry':
        process.env.npm_config_registry = value ?? args[++i]
        break
      case '--loglevel':
        if (value === undefined) i++
        break
      default:
        // Other npm options are accepted and ignored.
        break
    }
  }
  const rest = args.slice(i)
  // npm drops the `--` that separates its own options from a command's.
  const separator = rest.indexOf('--')
  if (separator >= 0) rest.splice(separator, 1)
  // `npm exec -- vite --host`: the command comes after the separator.
  if (stopAtFirstPositional && !positionals.length && rest.length) positionals.push(rest.shift()!)
  return { flags, positionals, rest }
}

const USAGE = `npm <command>

Usage (webcore's npm ${VERSION}):

npm install [<package-spec> ...]   install dependencies (alias: i, add)
npm ci                             install exactly what package-lock.json says
npm uninstall <name> ...           remove dependencies (alias: rm)
npm run <script> [-- <args>]       run a package.json script
npm test | start | stop | restart  run those scripts
npm exec <pkg> [-- <args>]         run a package's command (also: npx)
npm init [<initializer>]           create a package.json, or run create-<initializer>
`

export async function main(program: 'npm' | 'npx', argv: string[]): Promise<number> {
  try {
    if (program === 'npx') {
      const { flags, positionals, rest } = parseFlags(argv, true)
      silent = flags.silent
      return await exec(process.cwd(), positionals[0], rest, flags)
    }

    if (argv[0] === '-v' || argv[0] === '--version') {
      process.stdout.write(`${VERSION}\n`)
      return 0
    }
    const commandIndex = argv.findIndex((arg) => !arg.startsWith('-'))
    const name = commandIndex >= 0 ? argv[commandIndex] : undefined
    const command = name ? (ALIASES[name] ?? name) : undefined
    const args = commandIndex >= 0 ? [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)] : argv
    const cwd = process.cwd()

    switch (command) {
      case undefined:
      case 'help':
        process.stdout.write(USAGE)
        return command ? 0 : 1
      case 'install':
      case 'ci': {
        const { flags, positionals } = parseFlags(args, false)
        silent = flags.silent
        if (flags.global) {
          error('code EUNSUPPORTED\nGlobal installs are not supported yet. Use npx, or install into a project.')
          return 1
        }
        flags.packages = positionals
        return await install(findPrefix(cwd), flags, { ci: command === 'ci' })
      }
      case 'uninstall': {
        const { flags, positionals } = parseFlags(args, false)
        silent = flags.silent
        flags.packages = positionals
        return await uninstall(findPrefix(cwd), flags)
      }
      case 'run': {
        // Options before `--` are npm's; other words after the script name go to the script.
        const { flags, positionals, rest } = parseFlags(args, false)
        silent = flags.silent
        return await runScript(findPrefix(cwd), positionals[0], [...positionals.slice(1), ...rest], flags)
      }
      case 'test':
      case 'start':
      case 'stop':
      case 'restart': {
        const { flags, rest } = parseFlags(args, false)
        silent = flags.silent
        return await runScript(findPrefix(cwd), command, rest, flags)
      }
      case 'exec': {
        const { flags, positionals, rest } = parseFlags(args, true)
        silent = flags.silent
        return await exec(cwd, positionals[0], rest, flags)
      }
      case 'init': {
        const { flags, positionals, rest } = parseFlags(args, true)
        silent = flags.silent
        if (!positionals.length) return initDefault(cwd)
        return await exec(cwd, initializerPackage(positionals[0]), rest, flags)
      }
      case 'prefix':
        process.stdout.write(`${findPrefix(cwd)}\n`)
        return 0
      case 'root':
        process.stdout.write(`${join(findPrefix(cwd), 'node_modules')}\n`)
        return 0
      case 'version':
      case 'v':
        process.stdout.write(`${JSON.stringify({ npm: VERSION, node: process.versions.node }, null, 2)}\n`)
        return 0
      case 'config': {
        if (args[0] === 'get' && args[1] === 'registry') {
          process.stdout.write(`${loadConfig(findPrefix(cwd)).registry}\n`)
          return 0
        }
        error('code EUNSUPPORTED\nOnly `npm config get registry` is supported')
        return 1
      }
      default:
        error(`Unknown command: "${name}"\n\nTo see a list of supported npm commands, run:\n  npm help`)
        return 1
    }
  } catch (cause) {
    if (cause instanceof NpmError) {
      error(`code ${cause.code}\n${cause.message}`)
      return 1
    }
    throw cause
  }
}
