/** Folding A2UI messages into the surface a client draws.
 *
 * Messages arrive over the same SSE stream as every other stage event, and not
 * all at once: the component tree is sent when the contract is selected, and
 * the data only after the call returns. So a surface is built up rather than
 * received, and it is renderable -- as a skeleton -- from the moment the tree
 * lands.
 */

import { emptySurface, type A2uiMessage, type Component, type Surface } from './types'

function setAtPath(root: unknown, path: string | undefined, value: unknown): unknown {
  const keys = (path ?? '').split('/').filter(Boolean)
  if (keys.length === 0) return value

  // Clone along the way so React sees a new object and re-renders.
  const next = typeof root === 'object' && root !== null ? { ...(root as Record<string, unknown>) } : {}
  let node = next as Record<string, unknown>
  keys.slice(0, -1).forEach((key) => {
    const child = node[key]
    node[key] = typeof child === 'object' && child !== null ? { ...(child as Record<string, unknown>) } : {}
    node = node[key] as Record<string, unknown>
  })
  node[keys[keys.length - 1]] = value
  return next
}

/** Apply one message to the surfaces a run has produced so far. */
export function applyMessage(
  surfaces: Record<string, Surface>,
  message: A2uiMessage,
): Record<string, Surface> {
  if ('createSurface' in message) {
    const { surfaceId, catalogId } = message.createSurface
    return { ...surfaces, [surfaceId]: { ...emptySurface(surfaceId), catalogId } }
  }

  if ('updateComponents' in message) {
    const { surfaceId, components } = message.updateComponents
    const current = surfaces[surfaceId] ?? emptySurface(surfaceId)
    const byId: Record<string, Component> = { ...current.components }
    components.forEach((component) => {
      if (component?.id) byId[component.id] = component
    })
    return { ...surfaces, [surfaceId]: { ...current, components: byId } }
  }

  if ('updateDataModel' in message) {
    const { surfaceId, path, value } = message.updateDataModel
    const current = surfaces[surfaceId] ?? emptySurface(surfaceId)
    // A message with no `value` deletes what is at `path`; the spec allows it,
    // though the engine does not send that form today.
    const data = value === undefined && path ? current.data : setAtPath(current.data, path, value)
    return { ...surfaces, [surfaceId]: { ...current, data, hasData: true } }
  }

  return surfaces
}

export function applyMessages(
  surfaces: Record<string, Surface>,
  messages: A2uiMessage[],
): Record<string, Surface> {
  return messages.reduce(applyMessage, surfaces)
}

/** Whether there is enough to draw: a tree with the root A2UI requires. */
export function isRenderable(surface: Surface | undefined): surface is Surface {
  return Boolean(surface && surface.components.root)
}

/** Whether this batch carries the data a surface binds to.
 *
 * The tree is sent before the upstream call, so every surface begins without
 * one. A run that ends having never sent this is a surface that will never
 * fill -- propose-apply stops at the proposal, and a failed call has nothing
 * to bind -- and the client needs to tell those apart from one still in flight.
 */
export function carriesData(messages: A2uiMessage[]): boolean {
  return messages.some((message) => 'updateDataModel' in message)
}
