/** Reading values out of the data model, and formatting them.
 *
 * The one rule worth stating plainly, because it is A2UI's deliberate deviation
 * from RFC 6901: a pointer with a leading slash resolves from the ROOT of the
 * surface's data, and a pointer without one resolves against the ITEM currently
 * being instantiated by a template. `/name` and `name` are not two spellings of
 * the same lookup -- inside a row they mean different things, and only one of
 * them shows the merchant their products.
 */

import type { DataBinding, DynamicString, DynamicValue, FunctionCall } from './types'

/** Where a binding is read from: the whole result, plus the current item. */
export interface Scope {
  root: unknown
  item: unknown
}

function isBinding(value: unknown): value is DataBinding {
  return typeof value === 'object' && value !== null && 'path' in value && !('call' in value)
}

function isCall(value: unknown): value is FunctionCall {
  return typeof value === 'object' && value !== null && 'call' in value
}

/** Walk a JSON Pointer. Unresolvable at any step yields undefined, never a throw. */
export function resolvePath(path: string, scope: Scope): unknown {
  const absolute = path.startsWith('/')
  let node: unknown = absolute ? scope.root : scope.item

  for (const raw of path.split('/')) {
    if (raw === '') continue
    if (node === null || node === undefined) return undefined
    // ~1 and ~0 are RFC 6901's escapes for / and ~ inside a key.
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(node)) {
      const index = Number(key)
      if (!Number.isInteger(index)) return undefined
      node = node[index]
    } else if (typeof node === 'object') {
      node = (node as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return node
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** `${...}` inside a formatString template.
 *
 * Two forms are supported: a bare pointer, and a nested formatter call. The
 * nested form has to be matched first, or the inner `${/pointer}` it contains
 * would be consumed on its own and the wrapping call left as literal text.
 */
const NESTED_CALL = /\$\{\s*(\w+)\(([^)]*)\)\s*\}/g
const BARE_POINTER = /\$\{\s*(\/?[A-Za-z_][A-Za-z0-9_/~-]*)\s*\}/g

/** `value:${/expiry_date}, format:'MMM d, yyyy'` -> an args object. */
function parseCallArgs(raw: string, scope: Scope): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  // Split on commas that are not inside quotes.
  for (const part of raw.split(/,(?=(?:[^']*'[^']*')*[^']*$)/)) {
    const at = part.indexOf(':')
    if (at === -1) continue
    const name = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    if (!name) continue

    const quoted = value.match(/^'(.*)'$/)
    if (quoted) {
      args[name] = quoted[1]
      continue
    }
    const pointer = value.match(/^\$\{\s*(.+?)\s*\}$/)
    args[name] = pointer ? resolvePath(pointer[1], scope) : value
  }
  return args
}

function interpolate(template: string, scope: Scope): string {
  return template
    .replace(NESTED_CALL, (whole, name: string, rawArgs: string) => {
      const result = applyFunction(name, parseCallArgs(rawArgs, scope), scope)
      return result === undefined ? whole : result
    })
    .replace(BARE_POINTER, (_whole, pointer: string) => {
      const value = resolvePath(pointer, scope)
      return value === null || value === undefined ? '' : String(value)
    })
}

function formatCurrency(amount: number, currency: unknown, decimals: unknown): string {
  const code = typeof currency === 'string' && currency ? currency : undefined
  const digits = toNumber(decimals)
  try {
    return new Intl.NumberFormat(undefined, {
      style: code ? 'currency' : 'decimal',
      currency: code,
      ...(digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    }).format(amount)
  } catch {
    // An unknown currency code must not take the whole surface down with it.
    return code ? `${amount} ${code}` : String(amount)
  }
}

/** Unicode TR35 patterns, to the extent the contracts actually use them. */
function formatDate(value: unknown, pattern: string): string | undefined {
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return undefined

  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const full = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December']
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const daysFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const hours12 = date.getHours() % 12 || 12

  // Longest tokens first, so 'MMMM' is not eaten by 'MM'.
  const tokens: Array<[string, string]> = [
    ['yyyy', String(date.getFullYear())],
    ['yy', pad(date.getFullYear() % 100)],
    ['MMMM', full[date.getMonth()]],
    ['MMM', months[date.getMonth()]],
    ['MM', pad(date.getMonth() + 1)],
    ['M', String(date.getMonth() + 1)],
    ['EEEE', daysFull[date.getDay()]],
    ['E', days[date.getDay()]],
    ['dd', pad(date.getDate())],
    ['d', String(date.getDate())],
    ['HH', pad(date.getHours())],
    ['H', String(date.getHours())],
    ['hh', pad(hours12)],
    ['h', String(hours12)],
    ['mm', pad(date.getMinutes())],
    ['ss', pad(date.getSeconds())],
    ['a', date.getHours() < 12 ? 'AM' : 'PM'],
  ]

  let out = ''
  let i = 0
  while (i < pattern.length) {
    const match = tokens.find(([token]) => pattern.startsWith(token, i))
    if (match) {
      out += match[1]
      i += match[0].length
    } else {
      out += pattern[i]
      i += 1
    }
  }
  return out
}

function applyFunction(name: string, args: Record<string, unknown>, scope: Scope): string | undefined {
  const value = args.value

  switch (name) {
    case 'formatCurrency': {
      const amount = toNumber(value)
      return amount === undefined ? undefined : formatCurrency(amount, args.currency, args.decimals)
    }
    case 'formatNumber': {
      const amount = toNumber(value)
      if (amount === undefined) return undefined
      const digits = toNumber(args.decimals)
      return new Intl.NumberFormat(undefined, {
        useGrouping: args.grouping !== false,
        ...(digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits }),
      }).format(amount)
    }
    case 'formatDate':
      return value === undefined || value === null
        ? undefined
        : formatDate(value, String(args.format ?? ''))
    case 'formatString':
      return typeof value === 'string' ? interpolate(value, scope) : undefined
    case 'pluralize': {
      const count = toNumber(value)
      if (count === undefined) return undefined
      // CLDR categories, to the extent English needs them. `other` is required
      // by the spec, so it is always the fallback.
      const chosen =
        (count === 0 && args.zero) || (count === 1 && args.one) || (count === 2 && args.two) || args.other
      return typeof chosen === 'string' ? interpolate(chosen, scope) : undefined
    }
    default:
      return undefined
  }
}

/** Resolve a DynamicString to text, or undefined when it cannot be resolved.
 *
 * Undefined is meaningful: the caller renders a placeholder rather than the
 * word "undefined", which is the difference between a gap a reader recognises
 * and one that looks like data.
 */
export function evaluate(value: DynamicValue | undefined, scope: Scope): string | undefined {
  if (value === undefined || value === null) return undefined

  if (typeof value === 'string') {
    return value.includes('${') ? interpolate(value, scope) : value
  }

  // A literal number or boolean argument, e.g. `decimals: 2`.
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (isCall(value)) {
    const args: Record<string, unknown> = {}
    for (const [name, arg] of Object.entries(value.args ?? {})) {
      // A nested arg is evaluated in the same scope; a bare literal stays as it
      // is, so `decimals: 2` survives as a number rather than becoming "2".
      args[name] = isBinding(arg)
        ? resolvePath(arg.path, scope)
        : isCall(arg)
          ? evaluate(arg, scope)
          : arg
    }
    return applyFunction(value.call, args, scope)
  }

  if (isBinding(value)) {
    const resolved = resolvePath(value.path, scope)
    if (resolved === null || resolved === undefined) return undefined
    return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved)
  }

  return undefined
}
