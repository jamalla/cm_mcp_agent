export type StageType =
  | 'prompt_received'
  | 'routing'
  | 'contract_selected'
  | 'code_generated'
  | 'executing'
  | 'result'
  | 'cache_store'
  | 'cache_hit'
  | 'proposal'
  | 'surface'
  | 'error'
  | 'done'
  | 'stream_end'

export interface StageEvent {
  run_id: string
  seq: number
  type: StageType
  ts: number
  data: Record<string, any>
}

export interface UiHint {
  display: 'card' | 'table' | 'text' | 'json'
  title?: string
  primary?: string
  secondary?: string
}

export interface RunSummary {
  runId: string
  prompt: string
  durationMs?: number
  cached: boolean
  ok: boolean
}

/** The stages the trace can show, in the order they occur. */
export const STAGE_ORDER: StageType[] = [
  'prompt_received',
  'routing',
  'contract_selected',
  'code_generated',
  'executing',
  'result',
  'cache_hit',
  'cache_store',
  'proposal',
  'surface',
  'done',
]

export const STAGE_LABELS: Record<string, string> = {
  prompt_received: 'Prompt received',
  routing: 'Agent routing',
  contract_selected: 'Contract selected',
  code_generated: 'Code generated',
  executing: 'Executing in sandbox',
  result: 'Result',
  cache_store: 'Cache STORE',
  cache_hit: 'Cache HIT',
  proposal: 'Awaiting approval',
  surface: 'Rendering surface',
  error: 'Error',
  done: 'Done',
}

/** What is happening RIGHT NOW, in the present tense.
 *
 * Deliberately not STAGE_LABELS. Those name a stage in the trace, for a reader
 * studying what ran ("Contract selected", "Cache HIT"). These are for someone
 * waiting, who wants to know the machine is still working and roughly on what.
 *
 * Every one of them is driven by a real event. If a stage did not happen the
 * line never appears -- the same rule the trace follows, because a reassuring
 * message that is not tied to anything is just a spinner with opinions.
 */
export const STAGE_ACTIVITY: Record<string, string> = {
  prompt_received: 'Reading your question',
  routing: 'Choosing a tool',
  contract_selected: 'Reading the contract',
  surface: 'Laying out the answer',
  code_generated: 'Writing the code',
  executing: 'Calling the store',
  result: 'Shaping the result',
  cache_hit: 'Found it in the cache',
  cache_store: 'Saving for next time',
}
