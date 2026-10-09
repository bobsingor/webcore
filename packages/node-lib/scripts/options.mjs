// Derives Node's CLI option defaults and aliases from src/node_options.{cc,h}, matching what
// internalBinding('options').getCLIOptionsValues() returns in a real build.
// Build-time macros are resolved for webcore: no inspector, no SQLite, no amaro (yet).
const MACROS = {
  EXPERIMENTALS_DEFAULT_VALUE: false,
  HAVE_AMARO: false,
  HAVE_SQLITE: false,
  HAVE_INSPECTOR: false,
  // OpenSSL's DEFAULT_CIPHER_LIST_CORE, as reported by official builds.
  DEFAULT_CIPHER_LIST_CORE:
    'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:' +
    'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:' +
    'DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:' +
    'DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:' +
    '!RC4:!MD5:!PSK:!SRP:!CAMELLIA',
}

/** Evaluates simple integer initializers such as `16 * 1024` or `kDefaultCpuProfInterval`. */
function evaluateNumber(expression, constants) {
  const substituted = expression.replace(/\b[A-Za-z_]\w*\b/g, (name) => (name in constants ? `(${constants[name]})` : name))
  if (!/^[\d\s+\-*/()]+$/.test(substituted)) return 0
  return Function(`return (${substituted})`)()
}

export function extractOptions(cc, h) {
  const constants = {}
  for (const match of `${h}\n${cc}`.matchAll(/(?:constexpr|static const)\s+[\w:]+\s+(k\w+)\s*=\s*([^;]+);/g)) {
    constants[match[1]] = match[2].replace(/[uUlL]+\b/g, '')
  }
  const classes = {}
  for (const match of h.matchAll(/class (\w+Options) : public Options \{([\s\S]*?)\n\};/g)) classes[match[1]] = match[2]

  const defaultFor = (className, field) => {
    const body = classes[className]
    if (!body) return undefined
    // A field declared twice sits in #if/#else; official builds take the #else (last) branch.
    const decls = [...body.matchAll(new RegExp(`^\\s*([\\w:<>]+)\\s+${field}\\s*(?:=\\s*([\\s\\S]*?)|\\{([^}]*)\\})?\\s*;`, 'gm'))]
    const decl = decls.at(-1)
    if (!decl) return undefined
    const [, type, init = '', brace] = decl
    // Initializers selected by the preprocessor take their default branch: false / empty.
    const value = init.includes('#') ? '' : init.trim()
    switch (type) {
      case 'bool':
        return value in MACROS ? MACROS[value] : value === 'true'
      case 'std::string': {
        const literal = /^"((?:[^"\\]|\\.)*)"$/.exec(value)
        if (literal) return JSON.parse(`"${literal[1]}"`)
        return typeof MACROS[value] === 'string' ? MACROS[value] : ''
      }
      case 'std::vector<std::string>':
        return []
      case 'int64_t':
      case 'uint64_t':
      case 'int':
      case 'unsigned':
      case 'double':
        return value ? evaluateNumber(value, constants) : 0
      case 'HostPort':
        return brace !== undefined ? { host: '127.0.0.1', port: 9229 } : undefined
      default:
        return undefined
    }
  }

  const options = {}
  for (const match of cc.matchAll(/AddOption\(\s*"([^"]+)"([\s\S]*?)\);/g)) {
    const target = /&(\w+)::(\w+)/.exec(match[2])
    if (target) options[match[1]] = defaultFor(target[1], target[2])
  }
  const aliases = {}
  for (const match of cc.matchAll(/AddAlias\(\s*"([^"]+)"\s*,\s*(\{[^}]*\}|"[^"]+")\s*\)/g)) {
    aliases[match[1]] = [...match[2].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  }
  return { options, aliases }
}
