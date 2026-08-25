/** A2UI v0.9.1, as much of it as this client implements.
 *
 * The engine sends three message kinds. `createSurface` opens one,
 * `updateComponents` carries the tree the contract declared, and
 * `updateDataModel` carries the result it binds to. They arrive in that order
 * but not at the same time: the tree is known when the contract is selected,
 * the data only once the call returns.
 */

export const A2UI_VERSION = 'v0.9.1'

/** The components this client can draw.
 *
 * Presentation only, matching the contract schema. A2UI's interactive
 * components are not accepted upstream, because a control that calls back to
 * the agent would route around the propose-apply approval a write depends on.
 */
export type ComponentKind =
  | 'Text'
  | 'Column'
  | 'Row'
  | 'List'
  | 'Card'
  | 'Divider'
  | 'Image'

/** A value that is either written literally or read from the data model. */
export type DynamicString = string | DataBinding | FunctionCall

/** The same, for the arguments that are not strings.
 *
 * A2UI types a formatter's arguments individually: `formatCurrency.value` is a
 * DynamicNumber and `grouping` a DynamicBoolean, so `decimals: 2` is a literal
 * number and not the string "2". Narrowing every argument to a string would
 * reject calls the spec allows.
 */
export type DynamicValue = DynamicString | number | boolean

export interface DataBinding {
  /** JSON Pointer. A leading slash reads from the root; without one, from the
   *  item currently being instantiated by a template. */
  path: string
}

export interface FunctionCall {
  call: 'formatCurrency' | 'formatNumber' | 'formatDate' | 'formatString' | 'pluralize'
  args: Record<string, DynamicValue>
  returnType?: 'string'
}

/** Children are either a fixed list of ids, or a template repeated over a list. */
export type ChildList = string[] | ChildTemplate

export interface ChildTemplate {
  componentId: string
  /** Absolute pointer to the array to repeat over, e.g. `/items`. */
  path: string
}

export interface Component {
  id: string
  component: ComponentKind
  text?: DynamicString
  url?: DynamicString
  variant?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'caption' | 'body'
  children?: ChildList
  child?: string
  direction?: 'vertical' | 'horizontal'
  justify?: 'start' | 'center' | 'end' | 'spaceBetween' | 'spaceAround' | 'spaceEvenly' | 'stretch'
  align?: 'start' | 'center' | 'end' | 'stretch'
  weight?: number
}

export type A2uiMessage =
  | { version: string; createSurface: { surfaceId: string; catalogId: string } }
  | { version: string; updateComponents: { surfaceId: string; components: Component[] } }
  | { version: string; updateDataModel: { surfaceId: string; path?: string; value?: unknown } }

/** What the client accumulates for one surface as messages arrive. */
export interface Surface {
  surfaceId: string
  catalogId?: string
  components: Record<string, Component>
  data: unknown
  /** False until `updateDataModel` lands, which is what the skeleton keys off. */
  hasData: boolean
}

export function emptySurface(surfaceId: string): Surface {
  return { surfaceId, components: {}, data: undefined, hasData: false }
}
