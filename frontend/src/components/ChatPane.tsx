import { useEffect, useRef, useState } from 'react'
import { A2uiSurface } from '../a2ui/Render'
import { isRenderable } from '../a2ui/surface'
import type { Surface } from '../a2ui/types'
import type { UiHint } from '../types'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text?: string
  output?: Record<string, any>
  uiHint?: UiHint
  durationMs?: number
  cached?: boolean
  error?: string
  /** The A2UI surface this message renders, when the contract declared one. */
  surfaceId?: string
  proposal?: { action: string; args?: Record<string, any>; runId: string }
  resolved?: 'approved' | 'rejected'
}

/** Render one argument value the way an approver needs to read it.
 *
 * Booleans matter here: `freeShipping: false` is a decision the merchant is
 * approving, and React renders a raw `false` as nothing at all.
 */
function formatArg(value: any): string {
  if (value === null || value === undefined) return '—'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** The values the request will actually carry.
 *
 * The action line above shows only the method and the URL, which for a write
 * that carries everything in its body -- POST /coupons -- is identical for
 * every call. These are what differ, so without them "Approve" is a decision
 * taken blind.
 */
function ProposalArgs({ args }: { args?: Record<string, any> }) {
  const entries = Object.entries(args ?? {})
  if (entries.length === 0) return null

  return (
    <dl className="proposal-args">
      {entries.map(([name, value]) => (
        <div className="proposal-arg" key={name}>
          <dt>{name}</dt>
          <dd>{formatArg(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Fill a contract's `ui` hint template: "Category {name}" -> "Category Shoes". */
function interpolate(template: string | undefined, output: Record<string, any>): string {
  if (!template) return ''
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = output?.[key]
    return value === undefined || value === '' ? '—' : String(value)
  })
}

/** Copy the answer, with the button itself as the confirmation.
 *
 * A result worth reading is usually a result worth pasting somewhere -- into a
 * ticket, a spreadsheet, a message to whoever asked. `navigator.clipboard` is
 * unavailable over plain http on some hosts, so failure is silent and the label
 * simply does not change rather than throwing behind the scenes.
 */
function CopyButton({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* no clipboard permission -- leave the label alone rather than lie */
    }
  }

  return (
    <button className="copy-btn" onClick={copy} title="Copy this result as JSON">
      {copied ? 'copied' : 'copy'}
    </button>
  )
}

function ResultCard({ message }: { message: ChatMessage }) {
  const { output = {}, uiHint } = message

  if (!uiHint || uiHint.display === 'json') {
    return <pre className="result-json">{JSON.stringify(output, null, 2)}</pre>
  }

  return (
    <div className="result-card">
      <div className="result-title">{interpolate(uiHint.title, output)}</div>
      <div className="result-primary">{interpolate(uiHint.primary, output)}</div>
      {uiHint.secondary && (
        <div className="result-secondary">{interpolate(uiHint.secondary, output)}</div>
      )}
    </div>
  )
}

interface Props {
  messages: ChatMessage[]
  surfaces: Record<string, Surface>
  busy: boolean
  onSend: (prompt: string) => void
  onApprove: (runId: string, approve: boolean) => void
  onClearCache: () => void
  onNewChat: () => void
  onRetry: () => void
  canRetry: boolean
  suggestions: string[]
}

export function ChatPane({
  messages,
  surfaces,
  busy,
  onSend,
  onApprove,
  onClearCache,
  onNewChat,
  onRetry,
  canRetry,
  suggestions,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Ctrl/Cmd + K starts over, the way it does in most things with a chat in
  // them. Bound on the window rather than the input so it works while the
  // composer is disabled mid-run, which is exactly when someone wants out.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        onNewChat()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onNewChat])

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const value = inputRef.current?.value.trim()
    if (!value || busy) return
    onSend(value)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <section className="pane chat-pane">
      <header className="pane-header">
        <h2>Chat</h2>
        <div className="pane-actions">
          <button
            className="ghost-btn primary-ghost"
            onClick={onNewChat}
            disabled={messages.length === 0}
            title="Clear the conversation and the trace, and start again (Ctrl/Cmd + K)"
          >
            new chat
          </button>
          <button
            className="ghost-btn"
            onClick={onRetry}
            disabled={busy || !canRetry}
            title="Send the last question again"
          >
            retry
          </button>
          {/* Deliberately set apart: this one reaches the engine and changes
              what the NEXT run costs, which is a different kind of act from
              tidying the view. */}
          <span className="action-divider" aria-hidden="true" />
          <button
            className="ghost-btn"
            onClick={onClearCache}
            disabled={busy}
            title="Clear the engine's result and code caches, so the next run runs cold"
          >
            reset caches
          </button>
        </div>
      </header>

      <div className="messages">
        {messages.length === 0 && suggestions.length > 0 && (
          <div className="suggestions">
            {/* Drawn from the registry's own routing hints, so the offers here
                follow whatever was last merged rather than a hardcoded list. */}
            <p className="empty">Ask about the store — or start with one of these:</p>
            {suggestions.map((s) => (
              <button key={s} className="suggestion" onClick={() => onSend(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className={`message message-${message.role}`}>
            {message.role === 'user' ? (
              <p>{message.text}</p>
            ) : (
              <>
                {message.error && <p className="msg-error">{message.error}</p>}

                {message.proposal && (
                  <div className="proposal-card">
                    <p className="proposal-label">Approval required before this runs</p>
                    <p className="proposal-action">{message.proposal.action}</p>
                    <ProposalArgs args={message.proposal.args} />
                    {message.resolved ? (
                      <p className={`proposal-resolved ${message.resolved}`}>
                        {message.resolved === 'approved' ? 'Approved — applied.' : 'Rejected.'}
                      </p>
                    ) : (
                      <div className="proposal-buttons">
                        <button
                          className="approve"
                          onClick={() => onApprove(message.proposal!.runId, true)}
                        >
                          Approve
                        </button>
                        <button
                          className="reject"
                          onClick={() => onApprove(message.proposal!.runId, false)}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {message.surfaceId &&
                  (isRenderable(surfaces[message.surfaceId]) ? (
                    <>
                      <A2uiSurface surface={surfaces[message.surfaceId]} />
                      {surfaces[message.surfaceId].hasData && (
                        <CopyButton value={surfaces[message.surfaceId].data} />
                      )}
                    </>
                  ) : null)}

                {message.output && (
                  <>
                    <ResultCard message={message} />
                    <CopyButton value={message.output} />
                  </>
                )}

                {message.durationMs !== undefined && (
                  <p className="msg-meta">
                    <span className={message.cached ? 'pill pill-cache' : 'pill'}>
                      {message.cached ? 'cache hit' : 'executed'}
                    </span>
                    {message.durationMs} ms
                  </p>
                )}
              </>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          ref={inputRef}
          placeholder={busy ? 'working…' : 'Ask about the store…'}
          disabled={busy}
          autoFocus
        />
        <button type="submit" disabled={busy}>
          Send
        </button>
      </form>
    </section>
  )
}
