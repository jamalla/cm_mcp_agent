import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatPane, type ChatMessage } from './components/ChatPane'
import { PipelinePane } from './components/PipelinePane'
import { useEventStream } from './useEventStream'
import type { StageEvent } from './types'

/** A clickable prompt, taken from a contract's own routing hints.
 *
 * Authors write `whenToUse` entries like "The merchant wants an overview of
 * their category tree, e.g. 'what categories do I have?'" -- the quoted example
 * IS the prompt. Deriving the suggestions from the live registry means they
 * follow whatever was last merged upstream, instead of a hardcoded list that
 * silently starts offering prompts no tool can serve.
 */
function suggestionFrom(hint: string): string {
  const example = hint.match(/e\.g\.\s*['"‘“]([^'"’”]+)['"’”]/i)
  return (example ? example[1] : hint).replace(/\s+/g, ' ').trim()
}

type RegistryTool = { name: string; whenToUse?: string[] }

let messageCounter = 0
const nextId = () => `m${++messageCounter}`

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [health, setHealth] = useState<{ usingLlm: boolean; mcpConnected: boolean } | null>(null)
  const [toolCount, setToolCount] = useState<number | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [lastDuration, setLastDuration] = useState<number | undefined>()
  const { events, running, start, append } = useEventStream()
  const previousDuration = useRef<number | undefined>()

  useEffect(() => {
    fetch('/healthz').then((r) => r.json()).then(setHealth).catch(() => setHealth(null))
    fetch('/api/registry')
      .then((r) => r.json())
      .then((data) => {
        const tools: RegistryTool[] = data?.tools ?? []
        setToolCount(tools.length || null)
        // One prompt per contract, so every suggestion has a tool behind it.
        setSuggestions(
          tools
            .map((tool) => tool.whenToUse?.[0])
            .filter((hint): hint is string => Boolean(hint))
            .map(suggestionFrom)
            .slice(0, 4),
        )
      })
      .catch(() => setToolCount(null))
  }, [])

  const consume = useCallback((event: StageEvent) => {
    const d = event.data ?? {}

    if (event.type === 'result') {
      setMessages((prior) => [
        ...prior,
        { id: nextId(), role: 'assistant', output: d.output, uiHint: d.uiHint },
      ])
    }

    if (event.type === 'proposal') {
      setMessages((prior) => [
        ...prior,
        {
          id: nextId(),
          role: 'assistant',
          proposal: { action: d.action, runId: event.run_id },
        },
      ])
    }

    if (event.type === 'error') {
      setMessages((prior) => [
        ...prior,
        { id: nextId(), role: 'assistant', error: `${d.stage}: ${d.message}` },
      ])
    }

    if (event.type === 'done') {
      setMessages((prior) => {
        // Attach timing to the last assistant message of this run.
        const index = [...prior].reverse().findIndex((m) => m.role === 'assistant')
        if (index === -1) return prior
        const target = prior.length - 1 - index
        const next = [...prior]
        next[target] = { ...next[target], durationMs: d.durationMs, cached: !!d.cached }
        return next
      })
    }
  }, [])

  const send = useCallback(
    async (prompt: string) => {
      setMessages((prior) => [...prior, { id: nextId(), role: 'user', text: prompt }])
      previousDuration.current = lastDuration

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      const { run_id } = await response.json()
      await start(run_id, consume)
    },
    [consume, start, lastDuration],
  )

  // Remember the duration of the run that just finished, so the next run can
  // show the contrast rather than the audience having to remember it.
  useEffect(() => {
    const done = events.find((e) => e.type === 'done')
    if (done && !running) setLastDuration(done.data.durationMs)
  }, [events, running])

  const approve = useCallback(
    async (runId: string, ok: boolean) => {
      setMessages((prior) =>
        prior.map((m) =>
          m.proposal?.runId === runId
            ? { ...m, resolved: ok ? 'approved' : 'rejected' }
            : m,
        ),
      )
      const response = await fetch(`/api/approve/${runId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approve: ok }),
      })
      const body = await response.json()
      if (ok && body.run_id) {
        // The apply is a second MCP call with its own run; stream it in.
        const source = new EventSource(`/api/stream/${body.run_id}`)
        const collected: StageEvent[] = []
        source.onmessage = (message) => {
          const event = JSON.parse(message.data) as StageEvent
          if (event.type === 'stream_end') {
            source.close()
            append(collected)
            return
          }
          collected.push(event)
          consume(event)
        }
        source.onerror = () => source.close()
      }
    },
    [append, consume],
  )

  const clearCaches = useCallback(async () => {
    await fetch('/api/cache/clear', { method: 'POST' })
    setLastDuration(undefined)
    setMessages((prior) => [
      ...prior,
      { id: nextId(), role: 'assistant', error: 'Caches cleared — the next run runs cold.' },
    ])
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          Contract-Driven MCP
          <span className="sub">code-mode execution</span>
        </div>
        <div className="status">
          {toolCount !== null && <span>{toolCount} contracts in registry</span>}
          <span className={health?.mcpConnected ? 'ok' : 'bad'}>
            {health?.mcpConnected ? 'MCP connected' : 'MCP down'}
          </span>
          <span className="router-mode">
            {health?.usingLlm ? 'Claude router' : 'offline router'}
          </span>
        </div>
      </header>

      <main className="panes">
        <ChatPane
          messages={messages}
          busy={running}
          onSend={send}
          onApprove={approve}
          onClearCache={clearCaches}
          suggestions={suggestions}
        />
        <PipelinePane
          events={events}
          running={running}
          lastDuration={previousDuration.current}
        />
      </main>
    </div>
  )
}
