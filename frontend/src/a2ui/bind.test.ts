/** The lookups a blank column comes from.
 *
 * Every failure this file covers renders as EMPTY SPACE in the chat, with
 * nothing thrown and nothing logged. There is no runtime signal to catch them
 * by, which is the whole reason they are pinned here instead.
 *
 * The scope rule is the one that actually bites: `/name` and `name` are both
 * valid, and inside a row template only one of them is the record's field.
 */

import { describe, expect, it } from 'vitest'

import { evaluate, resolvePath, type Scope } from './bind'

const RESULT = {
  count: 2,
  items: [
    { name: 'Leather wallet', sku: 'LW-1', quantity: 0, price: { amount: 249, currency: 'SAR' } },
    { name: 'Suede belt', sku: 'SB-2', quantity: 7, price: { amount: 99.5, currency: 'SAR' } },
  ],
}

const root: Scope = { root: RESULT, item: RESULT }
const inRow: Scope = { root: RESULT, item: RESULT.items[0] }

describe('path resolution', () => {
  it('reads from the result when the pointer is absolute', () => {
    expect(resolvePath('/count', root)).toBe(2)
    expect(resolvePath('/items/1/sku', root)).toBe('SB-2')
  })

  it('reads from the current item when the pointer is relative', () => {
    expect(resolvePath('name', inRow)).toBe('Leather wallet')
    expect(resolvePath('price/amount', inRow)).toBe(249)
  })

  it('keeps the two scopes apart', () => {
    // The mistake this exists for: `/name` inside a row is not the record's
    // name, it is a field on the envelope -- which does not exist.
    expect(resolvePath('/name', inRow)).toBeUndefined()
    expect(resolvePath('count', inRow)).toBeUndefined()
    // ...while an absolute pointer still reaches the root from inside a row.
    expect(resolvePath('/count', inRow)).toBe(2)
  })

  it('gives up quietly on anything missing', () => {
    expect(resolvePath('/nope/deeper', root)).toBeUndefined()
    expect(resolvePath('sku/further', inRow)).toBeUndefined()
  })
})

describe('evaluate', () => {
  it('passes a literal through', () => {
    expect(evaluate('Store Products', root)).toBe('Store Products')
  })

  it('reports an unresolvable binding as undefined, not as "undefined"', () => {
    // The caller draws a placeholder for this. Stringifying here would put the
    // word undefined in front of a merchant.
    expect(evaluate({ path: 'missing' }, inRow)).toBeUndefined()
  })

  it('renders a zero rather than dropping it', () => {
    // `0 in stock` is the answer to "what is out of stock", so a falsy value
    // must survive every code path that might treat it as absent.
    expect(evaluate({ path: 'quantity' }, inRow)).toBe('0')
  })
})

describe('formatters', () => {
  const currency = {
    call: 'formatCurrency' as const,
    args: { value: { path: 'price/amount' }, currency: { path: 'price/currency' } },
  }

  it('formats Salla money objects', () => {
    // Salla money is {amount, currency}, never a scalar -- the formatter is
    // what stops a card reading [object Object].
    const out = evaluate(currency, inRow)
    expect(out).toBeDefined()
    expect(out).toMatch(/249/)
    expect(out).toMatch(/SAR|﷼/)
  })

  it('survives a currency code Intl does not know', () => {
    const out = evaluate(
      { call: 'formatCurrency', args: { value: 5, currency: 'NOT-A-CODE' } },
      root,
    )
    expect(out).toBe('5 NOT-A-CODE')
  })

  it('interpolates pointers inside a template string', () => {
    expect(evaluate({ call: 'formatString', args: { value: '${quantity} left' } }, inRow)).toBe('0 left')
    expect(evaluate({ call: 'formatString', args: { value: '#${/count}' } }, root)).toBe('#2')
  })

  it('interpolates a nested formatter call', () => {
    const out = evaluate(
      {
        call: 'formatString',
        args: { value: "Valid until ${formatDate(value:${/when}, format:'MMM d, yyyy')}" },
      },
      { root: { when: '2026-08-31 00:00:00' }, item: {} },
    )
    expect(out).toBe('Valid until Aug 31, 2026')
  })

  it('picks a plural category and interpolates the chosen string', () => {
    const plural = (value: number) =>
      evaluate(
        { call: 'pluralize', args: { value, one: '1 product', other: '${/count} products' } },
        { root: { count: value }, item: {} },
      )
    expect(plural(1)).toBe('1 product')
    expect(plural(2)).toBe('2 products')
    expect(plural(0)).toBe('0 products')
  })

  it('formats dates by TR35 token, longest first', () => {
    const at = { root: { d: '2026-01-05 14:30:00' }, item: {} }
    const fmt = (format: string) =>
      evaluate({ call: 'formatDate', args: { value: { path: '/d' }, format } }, at)

    expect(fmt('yyyy-MM-dd')).toBe('2026-01-05')
    expect(fmt('MMMM d')).toBe('January 5')
    expect(fmt('HH:mm')).toBe('14:30')
    expect(fmt('h:mm a')).toBe('2:30 PM')
  })

  it('returns undefined for a value it cannot format', () => {
    expect(evaluate({ call: 'formatDate', args: { value: 'not a date', format: 'yyyy' } }, root))
      .toBeUndefined()
    expect(evaluate({ call: 'formatCurrency', args: { value: { path: 'nope' }, currency: 'SAR' } }, inRow))
      .toBeUndefined()
  })
})
