/** Drawing an A2UI surface with this client's own components.
 *
 * The catalog is the security boundary. A surface names components; it never
 * ships any, and nothing here evaluates anything the sender wrote as code. A
 * component this client does not implement is skipped rather than guessed at.
 *
 * The tree is an adjacency list -- parents name children by id -- so rendering
 * is a walk from `root`, carrying the scope each child should read in. A
 * template swaps the scope to the item it is instantiating, which is the whole
 * mechanism behind one row per record.
 */

import type { JSX } from 'react'

import { evaluate, resolvePath, type Scope } from './bind'
import type { ChildTemplate, Component, Surface } from './types'

/** Guards a malformed tree: a cycle would otherwise recurse until the tab dies. */
const MAX_DEPTH = 24

function isTemplate(children: Component['children']): children is ChildTemplate {
  return typeof children === 'object' && children !== null && !Array.isArray(children)
}

function flex(justify?: string): string | undefined {
  switch (justify) {
    case 'spaceBetween': return 'space-between'
    case 'spaceAround': return 'space-around'
    case 'spaceEvenly': return 'space-evenly'
    case 'start': return 'flex-start'
    case 'end': return 'flex-end'
    case 'center': return 'center'
    case 'stretch': return 'stretch'
    default: return undefined
  }
}

function cross(align?: string): string | undefined {
  switch (align) {
    case 'start': return 'flex-start'
    case 'end': return 'flex-end'
    case 'center': return 'center'
    case 'stretch': return 'stretch'
    default: return undefined
  }
}

interface NodeProps {
  id: string
  surface: Surface
  scope: Scope
  depth: number
}

function Node({ id, surface, scope, depth }: NodeProps): JSX.Element | null {
  const component = surface.components[id]
  if (!component || depth > MAX_DEPTH) return null

  const style = component.weight ? { flexGrow: component.weight, flexBasis: 0, minWidth: 0 } : undefined

  const childNodes = (): JSX.Element[] => {
    const children = component.children
    if (!children) return []

    if (isTemplate(children)) {
      const list = resolvePath(children.path, scope)
      if (!Array.isArray(list)) return []
      // Each item becomes the scope for its own copy of the template, which is
      // what makes a relative path inside it mean "this record's field".
      return list.map((item, index) => (
        <Node
          key={`${children.componentId}-${index}`}
          id={children.componentId}
          surface={surface}
          scope={{ root: scope.root, item }}
          depth={depth + 1}
        />
      ))
    }

    return children.map((childId, index) => (
      <Node key={`${childId}-${index}`} id={childId} surface={surface} scope={scope} depth={depth + 1} />
    ))
  }

  switch (component.component) {
    case 'Text': {
      const text = evaluate(component.text, scope)
      const variant = component.variant ?? 'body'
      return (
        <div className={`a2ui-text a2ui-text-${variant}`} style={style}>
          {text === undefined || text === '' ? <span className="a2ui-empty">—</span> : text}
        </div>
      )
    }

    case 'Column':
    case 'Row': {
      const row = component.component === 'Row'
      return (
        <div
          className={`a2ui-${row ? 'row' : 'column'}`}
          style={{ ...style, justifyContent: flex(component.justify), alignItems: cross(component.align) }}
        >
          {childNodes()}
        </div>
      )
    }

    case 'List': {
      const horizontal = component.direction === 'horizontal'
      return (
        <div
          className={`a2ui-list ${horizontal ? 'a2ui-list-horizontal' : ''}`}
          style={{ ...style, alignItems: cross(component.align) }}
        >
          {childNodes()}
        </div>
      )
    }

    case 'Card':
      return (
        <div className="a2ui-card" style={style}>
          {component.child ? (
            <Node id={component.child} surface={surface} scope={scope} depth={depth + 1} />
          ) : null}
        </div>
      )

    case 'Divider':
      return <hr className="a2ui-divider" style={style} />

    case 'Image': {
      const url = evaluate(component.url, scope)
      // A nullable image is ordinary in this data -- a brand with no logo -- so
      // an absent url renders nothing rather than a broken-image icon.
      if (!url) return null
      return <img className="a2ui-image" src={url} alt="" style={style} loading="lazy" />
    }

    default:
      return null
  }
}

/** A surface, or its skeleton while the data is still in flight. */
export function A2uiSurface({ surface }: { surface: Surface }): JSX.Element {
  const scope: Scope = { root: surface.data, item: surface.data }

  return (
    <div className={`a2ui-surface ${surface.hasData ? '' : 'a2ui-pending'}`}>
      <Node id="root" surface={surface} scope={scope} depth={0} />
    </div>
  )
}
