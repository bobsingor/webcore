// A recursive-descent parser for the POSIX shell language, the subset scripts use: lists, && ||,
// pipelines, redirections, quoting, parameter and command substitution, if/for/while/until,
// groups and subshells. No here-documents, case or functions yet.

export type Part =
  | { type: 'text'; text: string; quoted: boolean }
  | { type: 'param'; name: string; quoted: boolean; op?: string; word?: Word }
  | { type: 'command'; list: List; quoted: boolean }
  | { type: 'tilde' }

export type Word = Part[]

export interface Redirect {
  fd: number
  op: '>' | '>>' | '<' | '>&' | '<&' | '&>' | '&>>' | '<>'
  target: Word
}

export interface Assignment {
  name: string
  value: Word
}

export type Command =
  | { type: 'simple'; assignments: Assignment[]; words: Word[]; redirects: Redirect[] }
  | { type: 'group' | 'subshell'; body: List; redirects: Redirect[] }
  | { type: 'if'; clauses: { condition: List; body: List }[]; otherwise?: List; redirects: Redirect[] }
  | { type: 'for'; name: string; items?: Word[]; body: List; redirects: Redirect[] }
  | { type: 'while'; until: boolean; condition: List; body: List; redirects: Redirect[] }

export interface Pipeline {
  negate: boolean
  commands: Command[]
}

export interface AndOr {
  first: Pipeline
  rest: { op: '&&' | '||'; pipeline: Pipeline }[]
}

export type List = { andOr: AndOr; background: boolean }[]

export class ShellSyntaxError extends Error {
  /** The input ended mid-construct: an interactive shell asks for more (PS2). */
  readonly incomplete: boolean

  constructor(message: string, incomplete = false) {
    super(message)
    this.incomplete = incomplete
  }
}

const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', '{', '}', '!'])
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SPECIAL_PARAMS = '?$#@*!0123456789-'

export function parse(source: string): List {
  return new Parser(source).script()
}

class Parser {
  private readonly src: string
  private pos = 0

  constructor(source: string) {
    this.src = source
  }

  script(): List {
    const list = this.list(new Set())
    this.skipBlanks()
    if (this.pos < this.src.length) this.fail(`syntax error near unexpected token \`${this.peekToken()}'`)
    return list
  }

  // --- lists ---------------------------------------------------------------------------------

  /** Parses commands until EOF, `)` or one of the `until` reserved words. */
  private list(until: Set<string>, closeParen = false): List {
    const items: List = []
    for (;;) {
      this.skipSeparators()
      if (this.pos >= this.src.length) break
      if (closeParen && this.src[this.pos] === ')') break
      const word = this.peekWord()
      if (word && until.has(word)) break
      const andOr = this.andOr()
      this.skipBlanks()
      const char = this.src[this.pos]
      let background = false
      if (char === '&' && this.src[this.pos + 1] !== '&') {
        background = true
        this.pos++
      } else if (char === ';' && this.src[this.pos + 1] !== ';') {
        this.pos++
      }
      items.push({ andOr, background })
    }
    return items
  }

  private andOr(): AndOr {
    const first = this.pipeline()
    const rest: AndOr['rest'] = []
    for (;;) {
      this.skipBlanks()
      const op = this.src.slice(this.pos, this.pos + 2)
      if (op !== '&&' && op !== '||') break
      this.pos += 2
      this.skipSeparators()
      rest.push({ op, pipeline: this.pipeline() })
    }
    return { first, rest }
  }

  private pipeline(): Pipeline {
    this.skipBlanks()
    let negate = false
    if (this.peekWord() === '!') {
      this.readWordText()
      negate = true
    }
    const commands = [this.command()]
    for (;;) {
      this.skipBlanks()
      if (this.src[this.pos] !== '|' || this.src[this.pos + 1] === '|') break
      this.pos++
      this.skipSeparators()
      commands.push(this.command())
    }
    return { negate, commands }
  }

  // --- commands ------------------------------------------------------------------------------

  private command(): Command {
    this.skipBlanks()
    if (this.src[this.pos] === '(') {
      this.pos++
      const body = this.list(new Set(), true)
      this.expect(')')
      return { type: 'subshell', body, redirects: this.redirects() }
    }
    switch (this.peekWord()) {
      case '{': {
        this.readWordText()
        const body = this.list(new Set(['}']))
        this.expectWord('}')
        return { type: 'group', body, redirects: this.redirects() }
      }
      case 'if':
        return this.ifCommand()
      case 'for':
        return this.forCommand()
      case 'while':
      case 'until':
        return this.whileCommand()
    }
    return this.simpleCommand()
  }

  private ifCommand(): Command {
    this.expectWord('if')
    const clauses: { condition: List; body: List }[] = []
    let otherwise: List | undefined
    for (;;) {
      const condition = this.list(new Set(['then']))
      this.expectWord('then')
      const body = this.list(new Set(['elif', 'else', 'fi']))
      clauses.push({ condition, body })
      const next = this.readWordText()
      if (next === 'elif') continue
      if (next === 'else') {
        otherwise = this.list(new Set(['fi']))
        this.expectWord('fi')
      } else if (next !== 'fi') {
        this.fail("syntax error: expected 'fi'")
      }
      break
    }
    return { type: 'if', clauses, otherwise, redirects: this.redirects() }
  }

  private forCommand(): Command {
    this.expectWord('for')
    this.skipBlanks()
    const name = this.readWordText()
    if (!NAME.test(name)) this.fail(`syntax error: bad for loop variable '${name}'`)
    let items: Word[] | undefined
    this.skipBlanks()
    if (this.peekWord() === 'in') {
      this.readWordText()
      items = []
      for (;;) {
        this.skipBlanks()
        const char = this.src[this.pos]
        if (char === undefined || char === ';' || char === '\n') break
        items.push(this.word())
      }
    }
    this.skipBlanks()
    if (this.src[this.pos] === ';') this.pos++
    this.skipSeparators()
    this.expectWord('do')
    const body = this.list(new Set(['done']))
    this.expectWord('done')
    return { type: 'for', name, items, body, redirects: this.redirects() }
  }

  private whileCommand(): Command {
    const until = this.readWordText() === 'until'
    const condition = this.list(new Set(['do']))
    this.expectWord('do')
    const body = this.list(new Set(['done']))
    this.expectWord('done')
    return { type: 'while', until, condition, body, redirects: this.redirects() }
  }

  private simpleCommand(): Command {
    const assignments: Assignment[] = []
    const words: Word[] = []
    const redirects: Redirect[] = []
    for (;;) {
      this.skipBlanks()
      const char = this.src[this.pos]
      if (char === undefined || char === '\n' || char === ';' || char === '&' || char === '|' || char === ')') {
        // `&>` is a redirection, not a background operator.
        if (!(char === '&' && this.src[this.pos + 1] === '>')) break
      }
      const redirect = this.redirect()
      if (redirect) {
        redirects.push(redirect)
        continue
      }
      if (char === '(') this.fail("syntax error near unexpected token `('")
      // NAME=value before the command name is an assignment.
      if (!words.length) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(this.src.slice(this.pos, this.pos + 256))
        if (match) {
          this.pos += match[0].length
          assignments.push({ name: match[1], value: this.word(true) })
          continue
        }
      }
      words.push(this.word())
    }
    if (!assignments.length && !words.length && !redirects.length) this.fail(`syntax error near unexpected token \`${this.peekToken()}'`)
    return { type: 'simple', assignments, words, redirects }
  }

  private redirects(): Redirect[] {
    const redirects: Redirect[] = []
    for (;;) {
      this.skipBlanks()
      const redirect = this.redirect()
      if (!redirect) return redirects
      redirects.push(redirect)
    }
  }

  private redirect(): Redirect | undefined {
    const match = /^(\d?)(&>>|&>|>>|>&|<&|<>|>\||>|<)/.exec(this.src.slice(this.pos, this.pos + 4))
    if (!match) return undefined
    if (match[2] === '<' && this.src[this.pos + 1] === '<') this.fail('here-documents are not supported')
    this.pos += match[0].length
    const op = (match[2] === '>|' ? '>' : match[2]) as Redirect['op']
    const fd = match[1] ? Number(match[1]) : op.startsWith('<') ? 0 : 1
    this.skipBlanks()
    if (this.atWordEnd()) this.fail(`syntax error near unexpected token \`${this.peekToken() || 'newline'}'`)
    return { fd, op, target: this.word() }
  }

  // --- words ---------------------------------------------------------------------------------

  /** Reads one word. In an assignment value, `~` after `:` also expands and the word may be empty. */
  private word(assignment = false): Word {
    const parts: Word = []
    const text = (value: string, quoted: boolean) => {
      const last = parts[parts.length - 1]
      if (last?.type === 'text' && last.quoted === quoted) last.text += value
      else parts.push({ type: 'text', text: value, quoted })
    }
    if (this.src[this.pos] === '~' && (assignment || this.isTildeEnd(this.pos + 1))) {
      parts.push({ type: 'tilde' })
      this.pos++
    }
    while (!this.atWordEnd()) {
      const char = this.src[this.pos]
      if (char === '\\') {
        const next = this.src[this.pos + 1]
        this.pos += 2
        if (next === '\n') continue
        if (next !== undefined) text(next, true)
      } else if (char === "'") {
        const end = this.src.indexOf("'", this.pos + 1)
        if (end < 0) this.fail('unterminated quoted string')
        text(this.src.slice(this.pos + 1, end), true)
        this.pos = end + 1
      } else if (char === '"') {
        this.pos++
        this.doubleQuoted(parts, text)
      } else if (char === '$') {
        this.dollar(parts, text, false)
      } else if (char === '`') {
        parts.push({ type: 'command', list: this.backquoted(), quoted: false })
      } else {
        text(char, false)
        this.pos++
      }
    }
    if (!parts.length && !assignment) this.fail('syntax error: empty word')
    return parts
  }

  private doubleQuoted(parts: Word, text: (value: string, quoted: boolean) => void): void {
    for (;;) {
      const char = this.src[this.pos]
      if (char === undefined) this.fail('unterminated quoted string')
      if (char === '"') {
        this.pos++
        // An empty "" still makes a (quoted) word.
        if (!parts.length) text('', true)
        return
      }
      if (char === '\\') {
        const next = this.src[this.pos + 1]
        this.pos += 2
        if (next === '\n') continue
        text('$`"\\'.includes(next) ? next : `\\${next}`, true)
      } else if (char === '$') {
        this.dollar(parts, text, true)
      } else if (char === '`') {
        parts.push({ type: 'command', list: this.backquoted(), quoted: true })
      } else {
        text(char, true)
        this.pos++
      }
    }
  }

  private dollar(parts: Word, text: (value: string, quoted: boolean) => void, quoted: boolean): void {
    const next = this.src[this.pos + 1]
    if (next === '(') {
      if (this.src[this.pos + 2] === '(') this.fail('arithmetic expansion is not supported')
      this.pos += 2
      const list = this.list(new Set(), true)
      this.expect(')')
      parts.push({ type: 'command', list, quoted })
    } else if (next === '{') {
      this.pos += 2
      const length = this.src[this.pos] === '#' && this.src[this.pos + 1] !== '}'
      if (length) this.pos++
      const name = /^([A-Za-z_][A-Za-z0-9_]*|[?$#@*!0-9-])/.exec(this.src.slice(this.pos))?.[0]
      if (!name) this.fail('bad substitution')
      this.pos += name.length
      if (length) {
        this.expect('}')
        parts.push({ type: 'param', name, quoted, op: '#' })
        return
      }
      const op = /^(:?[-=+?])/.exec(this.src.slice(this.pos))?.[0]
      let word: Word | undefined
      if (op) {
        this.pos += op.length
        word = this.braceWord()
      }
      this.expect('}')
      parts.push({ type: 'param', name, quoted, op, word })
    } else if (next !== undefined && /[A-Za-z_]/.test(next)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos + 1))![0]
      this.pos += 1 + name.length
      parts.push({ type: 'param', name, quoted })
    } else if (next !== undefined && SPECIAL_PARAMS.includes(next)) {
      this.pos += 2
      parts.push({ type: 'param', name: next, quoted })
    } else {
      text('$', quoted)
      this.pos++
    }
  }

  /** The word inside ${name:-word}, up to the closing brace. */
  private braceWord(): Word {
    const parts: Word = []
    const text = (value: string, quoted: boolean) => {
      const last = parts[parts.length - 1]
      if (last?.type === 'text' && last.quoted === quoted) last.text += value
      else parts.push({ type: 'text', text: value, quoted })
    }
    while (this.pos < this.src.length && this.src[this.pos] !== '}') {
      const char = this.src[this.pos]
      if (char === '$') this.dollar(parts, text, false)
      else if (char === '"') {
        this.pos++
        this.doubleQuoted(parts, text)
      } else if (char === "'") {
        const end = this.src.indexOf("'", this.pos + 1)
        if (end < 0) this.fail('unterminated quoted string')
        text(this.src.slice(this.pos + 1, end), true)
        this.pos = end + 1
      } else {
        text(char, false)
        this.pos++
      }
    }
    return parts
  }

  private backquoted(): List {
    let end = this.pos + 1
    let inner = ''
    for (; end < this.src.length && this.src[end] !== '`'; end++) {
      if (this.src[end] === '\\' && '$`\\'.includes(this.src[end + 1])) end++
      inner += this.src[end]
    }
    if (end >= this.src.length) this.fail('unterminated command substitution')
    this.pos = end + 1
    return new Parser(inner).script()
  }

  // --- lexical helpers -----------------------------------------------------------------------

  private atWordEnd(): boolean {
    const char = this.src[this.pos]
    return char === undefined || /[\s|&;<>()]/.test(char)
  }

  private isTildeEnd(at: number): boolean {
    const char = this.src[at]
    return char === undefined || char === '/' || /[\s|&;<>()]/.test(char)
  }

  private skipBlanks(): void {
    for (;;) {
      const char = this.src[this.pos]
      if (char === ' ' || char === '\t' || char === '\r') this.pos++
      else if (char === '\\' && this.src[this.pos + 1] === '\n') this.pos += 2
      else if (char === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++
      } else return
    }
  }

  private skipSeparators(): void {
    for (;;) {
      this.skipBlanks()
      if (this.src[this.pos] === '\n') this.pos++
      else return
    }
  }

  /** The next plain word, if it could be a reserved word. */
  private peekWord(): string | undefined {
    const match = /^[^\s|&;<>()'"`$\\]+/.exec(this.src.slice(this.pos, this.pos + 16))
    if (!match) return undefined
    const end = this.pos + match[0].length
    if (end < this.src.length && !/[\s|&;<>()]/.test(this.src[end])) return undefined
    return RESERVED.has(match[0]) ? match[0] : undefined
  }

  private readWordText(): string {
    this.skipBlanks()
    const match = /^[^\s|&;<>()]+/.exec(this.src.slice(this.pos))
    const word = match?.[0] ?? ''
    this.pos += word.length
    return word
  }

  private peekToken(): string {
    return /^(&&|\|\||;;|[|&;<>()]|[^\s|&;<>()]+)/.exec(this.src.slice(this.pos))?.[0] ?? ''
  }

  private expect(char: string): void {
    this.skipSeparators()
    if (this.src[this.pos] !== char) this.fail(`syntax error: expected '${char}'`)
    this.pos++
  }

  private expectWord(word: string): void {
    this.skipSeparators()
    if (this.peekWord() !== word) this.fail(`syntax error: expected '${word}'`)
    this.readWordText()
  }

  private fail(message: string): never {
    const atEnd = !this.src.slice(this.pos).trim()
    throw new ShellSyntaxError(message, atEnd || /^unterminated /.test(message))
  }
}
