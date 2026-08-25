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
