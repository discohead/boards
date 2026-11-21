// Flags and positionals. A command declares its flags; anything else is misuse.
//   string: --name value or --name=value     list: repeatable string     bool: --name
import { misuse } from './failure.mjs'

export const GLOBAL_FLAGS = {
  url: 'string',
  token: 'string',
  as: 'string',
  json: 'bool',
  help: 'bool',
}
const SHORT = { h: 'help' }

/**
 * @param {string[]} argv
 * @param {Record<string, 'string' | 'list' | 'bool'>} spec
 * @param {string} command what to name in a misuse error
 */
export function parse(argv, spec, command) {
  const all = { ...GLOBAL_FLAGS, ...spec }
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    let name = null
    let value
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=')
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      if (eq !== -1) value = arg.slice(eq + 1)
    } else if (/^-[A-Za-z]$/.test(arg)) {
      name = SHORT[arg.slice(1)] ?? null
      if (!name) throw unknown(arg, command)
    } else {
      positionals.push(arg)
      continue
    }
    const type = all[name]
    if (!type) throw unknown('--' + name, command)
    if (type === 'bool') {
      if (value !== undefined) throw misuse('invalid_flag', '--' + name + ' takes no value', [[...command.split(' '), '--help']])
      flags[name] = true
      continue
    }
    if (value === undefined) {
      if (i + 1 >= argv.length) throw misuse('missing_value', '--' + name + ' needs a value', [[...command.split(' '), '--help']])
      value = argv[++i]
    }
    if (type === 'list') (flags[name] ??= []).push(value)
    else flags[name] = value
  }
  return { flags, positionals }
}

const unknown = (flag, command) => misuse('unknown_flag', command + ' takes no ' + flag, [['wb', ...command.split(' ').slice(1), '--help']])

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** 30s, 10m, 1.5h, 1d, or plain seconds, in milliseconds. */
export function duration(text, flag) {
  const found = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(String(text).trim())
  if (!found) throw misuse('invalid_duration', flag + ' is a duration like 30s, 10m, 1h, or 1d, not ' + text)
  return Math.round(Number(found[1]) * UNITS[found[2] ?? 's'])
}

/** k=v pairs as an object; a bare key is refused. */
export function pairs(list, flag) {
  const out = {}
  for (const item of list ?? []) {
    const eq = item.indexOf('=')
    if (eq <= 0) throw misuse('invalid_label', flag + ' takes key=value, not ' + item)
    out[item.slice(0, eq)] = item.slice(eq + 1)
  }
  return out
}

/** A whole number, or misuse. */
export function count(text, flag, min = 1) {
  if (text === undefined) return undefined
  if (!/^\d+$/.test(String(text)) || Number(text) < min) throw misuse('invalid_number', flag + ' is a whole number of at least ' + min + ', not ' + text)
  return Number(text)
}
