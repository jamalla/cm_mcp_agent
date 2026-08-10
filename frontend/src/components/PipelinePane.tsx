import { useState } from 'react'
import { Code } from './Code'
import { STAGE_LABELS, type StageEvent } from '../types'

const STAGE_ICON: Record<string, string> = {
  prompt_received: '›',
  routing: '◈',
  contract_selected: '▣',
  code_generated: '⌨',
  executing: '▸',
  result: '✓',
  cache_store: '⤓',
  cache_hit: '⚡',
  proposal: '⚠',
  error: '✕',
  done: '●',
}

function Expandable({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="expandable">
      <button className="expand-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <div className="expand-body">{children}</div>}
    </div>
  )
}

function StageBody({ event }: { event: StageEvent }) {
  const d = event.data ?? {}

  switch (event.type) {
    case 'prompt_received':
      return <p className="stage-text">“{d.prompt}”</p>

    case 'routing':
      return (
        <>
          <p className="stage-text">
            Chose <strong className="hl">{d.chosen ?? 'nothing'}</strong>
            <span className="router-badge">{d.usingLlm ? 'Claude router' : 'offline router'}</span>
          </p>
          <p className="rationale">{d.rationale}</p>
          {Array.isArray(d.candidates) && d.candidates.length > 0 && (
            <Expandable label={`${d.candidates.length} candidates considered`}>
              <ul className="candidates">
                {d.candidates.map((c: any) => (
                  <li key={c.name}>
                    <span className="cand-name">{c.name}</span>
                    {c.score !== undefined && <span className="cand-score">{c.score}</span>}
                    <span className="cand-why">{c.why}</span>
                  </li>
                ))}
              </ul>
            </Expandable>
          )}
          {d.args && Object.keys(d.args).length > 0 && (
            <p className="args">
              args: <code>{JSON.stringify(d.args)}</code>
            </p>
          )}
        </>
      )

    case 'contract_selected':
      return (
        <>
          <p className="stage-text">
            <strong className="hl">{d.contractName}</strong>
            <span className="version">v{d.version}</span>
            {d.package && <span className="pkg">from {d.package}</span>}
          </p>
          {d.contract && (
            <Expandable label="contract JSON">
              <Code code={JSON.stringify(d.contract, null, 2)} language="json" />
            </Expandable>
          )}
        </>
      )

    case 'code_generated':
      return (
        <>
          <p className="stage-text">
            {d.fromCache ? (
              <>
                Reused cached code for <code>{d.cacheKey}</code>
              </>
            ) : (
              <>Generated from the contract — deterministic template fill, no LLM.</>
            )}
          </p>
          {d.code && (
            <Expandable label={`generated code (${d.code.split('\n').length} lines)`}>
              <Code code={d.code} language="python" maxHeight={420} />
            </Expandable>
          )}
        </>
      )

    case 'executing':
      return (
        <p className="stage-text">
          Running in a sandboxed subprocess · binding <code>{d.binding}</code>
        </p>
      )

    case 'result':
      return (
        <Expandable label="result JSON">
          <Code code={JSON.stringify(d.output, null, 2)} language="json" />
        </Expandable>
      )

    case 'cache_store':
      return (
        <p className="stage-text">
          Stored <code>{d.key}</code>
          {d.ttlSeconds ? ` · ttl ${d.ttlSeconds}s` : ''}
        </p>
      )

    case 'cache_hit':
      return (
        <p className="stage-text">
          Served from cache — code generation and execution were skipped entirely.
        </p>
      )

    case 'proposal':
      return (
        <>
          <p className="stage-text">{d.reason}</p>
          <p className="proposal-action">{d.action}</p>
        </>
      )

    case 'error':
      return (
        <p className="stage-text error-text">
          <strong>{d.stage}</strong>: {d.message}
        </p>
      )

    case 'done':
      return (
        <p className="stage-text">
          <strong className={d.cached ? 'hl-cache' : 'hl'}>{d.durationMs} ms</strong>
          {d.cached ? ' · served from cache' : ' · executed'}
        </p>
      )

    default:
      return null
  }
}

interface Props {
  events: StageEvent[]
  running: boolean
  lastDuration?: number
}

export function PipelinePane({ events, running, lastDuration }: Props) {
  const done = events.find((e) => e.type === 'done')
  const cacheHit = events.some((e) => e.type === 'cache_hit')
  const cacheStore = events.some((e) => e.type === 'cache_store')

  return (
    <section className="pane pipeline-pane">
      <header className="pane-header">
        <h2>Pipeline trace</h2>
        <div className="badges">
          {cacheHit && <span className="badge badge-hit">CACHE HIT</span>}
          {cacheStore && <span className="badge badge-store">CACHE STORE</span>}
          {done && (
            <span className={`badge badge-time ${cacheHit ? 'fast' : ''}`}>
              {done.data.durationMs} ms
            </span>
          )}
          {lastDuration !== undefined && done && (
            <span className="badge badge-delta">
              was {lastDuration} ms
            </span>
          )}
        </div>
      </header>

      <div className="stages">
        {events.length === 0 && !running && (
          <p className="empty">
            Send a prompt to watch it travel: routing → contract → generated code →
            execution → result → cache.
          </p>
        )}

        {events.map((event) => (
          <article
            key={`${event.run_id}-${event.seq}`}
            className={`stage stage-${event.type}`}
          >
            <div className="stage-icon">{STAGE_ICON[event.type] ?? '•'}</div>
            <div className="stage-main">
              <h3 className="stage-title">
                {STAGE_LABELS[event.type] ?? event.type}
                {event.type === 'code_generated' && event.data.fromCache && (
                  <span className="chip">code cache</span>
                )}
              </h3>
              <StageBody event={event} />
            </div>
          </article>
        ))}

        {running && (
          <div className="stage stage-pending">
            <div className="stage-icon spin">◌</div>
            <div className="stage-main">
              <h3 className="stage-title dim">working…</h3>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
