import { useEffect, useRef } from 'react'
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
  proposal?: { action: string; runId: string }
  resolved?: 'approved' | 'rejected'
}

/** Fill a contract's `ui` hint template: "Category {name}" -> "Category Shoes". */
function interpolate(template: string | undefined, output: Record<string, any>): string {
  if (!template) return ''
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = output?.[key]
    return value === undefined || value === '' ? '—' : String(value)
  })
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
  busy: boolean
  onSend: (prompt: string) => void
  onApprove: (runId: string, approve: boolean) => void
  onClearCache: () => void
  suggestions: string[]
}

export function ChatPane({
  messages,
  busy,
  onSend,
  onApprove,
  onClearCache,
  suggestions,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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
        <button className="ghost-btn" onClick={onClearCache} disabled={busy}>
          reset caches
        </button>
      </header>

      <div className="messages">
        {messages.length === 0 && suggestions.length > 0 && (
          <div className="suggestions">
            <p className="empty">Try one of these:</p>
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

                {message.output && <ResultCard message={message} />}

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
