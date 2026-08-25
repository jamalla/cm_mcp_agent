/** Folding the engine's messages into something drawable.
 *
 * The tree and the data arrive at different moments, so the interesting
 * assertions are about the gap between them: a surface must be renderable from
 * the tree alone, and must not claim to have data it has not been sent.
 */

import { describe, expect, it } from 'vitest'

import { applyMessages, carriesData, isRenderable } from './surface'
import type { A2uiMessage, Surface } from './types'

const V = 'v0.9.1'

const TREE: A2uiMessage[] = [
  { version: V, createSurface: { surfaceId: 'run-1', catalogId: 'a2ui.org:basic' } },
  {
    version: V,
    updateComponents: {
      surfaceId: 'run-1',
      components: [
        { id: 'root', component: 'Column', children: ['rows'] },
        { id: 'rows', component: 'List', children: { componentId: 'row', path: '/items' } },
        { id: 'row', component: 'Text', text: { path: 'name' } },
      ],
    },
  },
]

const DATA: A2uiMessage[] = [
  { version: V, updateDataModel: { surfaceId: 'run-1', value: { items: [{ name: 'Shoes' }] } } },
]

describe('applyMessages', () => {
  it('is drawable from the tree alone, before any data', () => {
    const surfaces = applyMessages({}, TREE)
    const surface = surfaces['run-1']

    expect(isRenderable(surface)).toBe(true)
    // The skeleton keys off this: dimmed while the call is still running.
    expect(surface.hasData).toBe(false)
    expect(surface.data).toBeUndefined()
    expect(Object.keys(surface.components).sort()).toEqual(['root', 'row', 'rows'])
    expect(surface.catalogId).toBe('a2ui.org:basic')
  })

  it('fills the data in when it lands', () => {
    const surface = applyMessages(applyMessages({}, TREE), DATA)['run-1']

    expect(surface.hasData).toBe(true)
    expect(surface.data).toEqual({ items: [{ name: 'Shoes' }] })
    // The tree must survive the data arriving.
    expect(Object.keys(surface.components)).toHaveLength(3)
  })

  it('writes into a path without discarding the rest', () => {
    const surface = applyMessages(applyMessages(applyMessages({}, TREE), DATA), [
      { version: V, updateDataModel: { surfaceId: 'run-1', path: '/count', value: 1 } },
    ])['run-1']

    expect(surface.data).toEqual({ items: [{ name: 'Shoes' }], count: 1 })
  })

  it('replaces the data model on a new object, so React re-renders', () => {
    const before = applyMessages({}, TREE)
    const after = applyMessages(before, DATA)

    expect(after).not.toBe(before)
    expect(after['run-1']).not.toBe(before['run-1'])
  })

  it('keeps concurrent runs apart', () => {
    const other: A2uiMessage[] = [
      { version: V, createSurface: { surfaceId: 'run-2', catalogId: 'a2ui.org:basic' } },
    ]
    const surfaces = applyMessages(applyMessages({}, TREE), other)

    expect(Object.keys(surfaces).sort()).toEqual(['run-1', 'run-2'])
    expect(isRenderable(surfaces['run-2'])).toBe(false)
  })

  it('is not drawable without a root, which A2UI requires', () => {
    const rootless = applyMessages({}, [
      { version: V, createSurface: { surfaceId: 'run-3', catalogId: 'a2ui.org:basic' } },
      {
        version: V,
        updateComponents: {
          surfaceId: 'run-3',
          components: [{ id: 'stray', component: 'Text', text: 'hello' }],
        },
      },
    ])

    expect(isRenderable(rootless['run-3'])).toBe(false)
  })

  it('ignores a message kind it does not implement', () => {
    const before = applyMessages({}, TREE)
    const after = applyMessages(before, [
      { version: V, deleteSurface: { surfaceId: 'run-1' } } as unknown as A2uiMessage,
    ])
    expect(after['run-1']).toBe(before['run-1'])
  })
})

describe('isRenderable', () => {
  it('rejects a surface that was never opened', () => {
    expect(isRenderable(undefined)).toBe(false)
    expect(isRenderable({ surfaceId: 'x', components: {}, data: undefined, hasData: false } as Surface))
      .toBe(false)
  })
})

describe('carriesData', () => {
  it('is false for the tree the engine sends before the call', () => {
    // Every surface starts here. Treating this as "filled" would leave a
    // skeleton on screen for runs that never produce data.
    expect(carriesData(TREE)).toBe(false)
  })

  it('is true once the result lands', () => {
    expect(carriesData(DATA)).toBe(true)
    expect(carriesData([...TREE, ...DATA])).toBe(true)
  })

  it('is false for an empty batch', () => {
    expect(carriesData([])).toBe(false)
  })
})
