import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatPane, type ChatMessage } from './components/ChatPane'
import { PipelinePane } from './components/PipelinePane'
import { RegistryPanel, isApproved, type Registry } from './components/RegistryPanel'
import { useEventStream } from './useEventStream'
import { applyMessages, carriesData } from './a2ui/surface'
import type { A2uiMessage, Surface } from './a2ui/types'
import { STAGE_ACTIVITY, type StageEvent } from './types'

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

/** Ambiguity-free alphabet: no I/O/0/1, so a code read off a screen and typed
 *  back in survives the trip. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function freshSuffix(): string {
  return Array.from(
    { length: 4 },
    () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
  ).join('')
}

/** A demo prompt has to work for whoever clicks it.
 *
 * A coupon code is unique per store, so the example baked into the contract's
 * own hint -- SUMMER10 -- works exactly ONCE. Every tester after the first gets
 * a 422 for a duplicate code and reads it as the platform being broken, which is
 * the opposite of what a suggestion is for.
 *
 * The suffix is generated per session and shown in the chip itself, so what the
 * button says is exactly what gets sent -- the prompt stays honest rather than
 * being rewritten on its way out.
 */
function withFreshCode(prompt: string, suffix: string): string {
  if (!/coupon|code/i.test(prompt)) return prompt
  return prompt.replace(/[A-Z][A-Z0-9]{3,}/, (code) => code + suffix)
}

let messageCounter = 0
const nextId = () => `m${++messageCounter}`

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [health, setHealth] = useState<{ usingLlm: boolean; mcpConnected: boolean } | null>(null)
  const [registry, setRegistry] = useState<Registry | null>(null)
  const [registryOpen, setRegistryOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  // Regenerated per session and on 'new chat', so a second tester -- or a
  // second attempt -- still gets a code the store has not seen.
  const [codeSuffix, setCodeSuffix] = useState(freshSuffix)
  // The apply half of propose-apply streams on its own EventSource rather
  // than through the hook, so it needs its own stage to report -- otherwise
  // approving a write is followed by silence until it lands.
  const [applyStage, setApplyStage] = useState<string | null>(null)
  // Surfaces that actually received their data. A tree is sent before the
  // call, so every surface starts without one -- this is how we tell a
  // skeleton that is still filling from one that never will.
  const filled = useRef<Set<string>>(new Set())
  const [lastDuration, setLastDuration] = useState<number | undefined>()
  // A2UI surfaces, keyed by surfaceId. Built up as messages arrive: the tree
  // lands when the contract is selected, the data only after the call.
  const [surfaces, setSurfaces] = useState<Record<string, Surface>>({})
  const { events, running, start, stop, append, clear } = useEventStream()
  const previousDuration = useRef<number | undefined>()

  const loadRegistry = useCallback(async () => {
    try {
      const data: Registry = await (await fetch('/api/registry')).json()
      setRegistry(data)
      // One prompt per contract, so every suggestion has a tool behind it.
      setSuggestions(
        (data.tools ?? [])
          .map((tool) => tool.whenToUse?.[0])
          .filter((hint): hint is string => Boolean(hint))
          .map(suggestionFrom)
          .slice(0, 4),
      )
    } catch {
      setRegistry(null)
    }
  }, [])

  const refreshRegistry = useCallback(async () => {
    // Re-reads the engine's source, then re-reads the catalog it produced.
    await fetch('/api/registry/refresh', { method: 'POST' }).catch(() => undefined)
    await loadRegistry()
  }, [loadRegistry])

  useEffect(() => {
    fetch('/healthz').then((r) => r.json()).then(setHealth).catch(() => setHealth(null))
    void loadRegistry()
  }, [loadRegistry])

  const consume = useCallback((event: StageEvent) => {
    const d = event.data ?? {}

    if (event.type === 'surface') {
      const surfaceId: string = d.surfaceId
      const messages: A2uiMessage[] = d.messages ?? []
      if (carriesData(messages)) filled.current.add(surfaceId)
      setSurfaces((prior) => applyMessages(prior, messages))
      // Placed on the first message for this surface -- the tree -- so the
      // shape of the answer is on screen while the call is still running.
      setMessages((prior) =>
        prior.some((m) => m.surfaceId === surfaceId)
          ? prior
          : [...prior, { id: nextId(), role: 'assistant', surfaceId }],
      )
    }

    if (event.type === 'result') {
      // A surface renders the result itself; only fall back to the raw payload
      // when the contract declared none.
      setMessages((prior) =>
        prior.some((m) => m.surfaceId === event.run_id)
          ? prior
          : [...prior, { id: nextId(), role: 'assistant', output: d.output }],
      )
    }

    if (event.type === 'proposal') {
      setMessages((prior) => [
        ...prior,
        {
          id: nextId(),
          role: 'assistant',
          proposal: { action: d.action, args: d.args, runId: event.run_id },
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
      // A run can end without ever sending its data: propose-apply stops at the
      // proposal, and a failed call has nothing to bind. The tree is already on
      // screen by then, so without this the merchant is left looking at a card
      // that will never fill -- a skeleton is a promise, and this one was broken.
      if (!filled.current.has(event.run_id)) {
        setMessages((prior) => prior.filter((m) => m.surfaceId !== event.run_id))
        setSurfaces((prior) => {
          if (!(event.run_id in prior)) return prior
          const next = { ...prior }
          delete next[event.run_id]
          return next
        })
      }

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
        setApplyStage('executing')
        source.onmessage = (message) => {
          const event = JSON.parse(message.data) as StageEvent
          if (event.type === 'stream_end') {
            source.close()
            setApplyStage(null)
            append(collected)
            return
          }
          collected.push(event)
          setApplyStage(event.type)
          consume(event)
        }
        source.onerror = () => {
          source.close()
          setApplyStage(null)
        }
      }
    },
    [append, consume],
  )

  /** The last thing the user actually asked, for retrying it.
   *
   *  Derived rather than stored: the transcript already knows, and a second
   *  copy is a second thing to keep in step with clearing.
   */
  const lastPrompt = messages.reduce<string | undefined>(
    (found, m) => (m.role === 'user' && m.text ? m.text : found),
    undefined,
  )

  /** The line shown to whoever is waiting: what is happening, and on what.
   *
   *  Read off the latest real event rather than a timer, so it cannot claim a
   *  stage that never ran. Once a contract has been chosen its name is carried
   *  along, because "Calling the store" is far less reassuring than knowing
   *  WHICH tool is doing the calling.
   */
  const activity = (() => {
    if (!running) {
      return applyStage ? (STAGE_ACTIVITY[applyStage] ?? 'Applying the change') : null
    }
    const chosen = [...events].reverse().find((e) => e.type === 'contract_selected')
    for (const event of [...events].reverse()) {
      const phrase = STAGE_ACTIVITY[event.type]
      if (!phrase) continue
      const tool = chosen?.data?.contractName
      return tool && event.type !== 'routing' ? `${phrase} · ${tool}` : phrase
    }
    return 'Working'
  })()

  const newChat = useCallback(() => {
    // A run in flight would otherwise keep appending to a conversation the user
    // has already walked away from. The backend finishes on its own; we stop
    // listening, which is the honest thing for the view to do.
    stop()
    clear()
    setMessages([])
    setSurfaces({})
    setLastDuration(undefined)
    previousDuration.current = undefined
    setCodeSuffix(freshSuffix())
    filled.current.clear()
  }, [stop, clear])

  const retry = useCallback(() => {
    if (lastPrompt && !running) void send(lastPrompt)
  }, [lastPrompt, running, send])

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
          {registry && (
            // The approved set is worth opening, not just counting: it is the
            // whole surface the agent is allowed to choose from.
            <button className="registry-toggle" onClick={() => setRegistryOpen((o) => !o)}>
              {registry.tools.length} tool{registry.tools.length === 1 ? '' : 's'}
              {/* Says which axis it is talking about: where the contracts came
                  from, not which upstream they call. */}
              <em className={isApproved(registry) ? 'ok' : 'warn'}>
                {isApproved(registry) ? 'approved registry' : 'local checkout'}
              </em>
            </button>
          )}
          <span className={health?.mcpConnected ? 'ok' : 'bad'}>
            {health?.mcpConnected ? 'MCP connected' : 'MCP down'}
          </span>
          <span className="router-mode">
            {health?.usingLlm ? 'OpenAI router' : 'offline router'}
          </span>
        </div>
      </header>

      {registryOpen && registry && (
        <RegistryPanel
          registry={registry}
          onClose={() => setRegistryOpen(false)}
          onRefresh={refreshRegistry}
        />
      )}

      <main className="panes">
        <ChatPane
          messages={messages}
          surfaces={surfaces}
          activity={activity}
          onNewChat={newChat}
          onRetry={retry}
          canRetry={Boolean(lastPrompt)}
          busy={running || applyStage !== null}
          onSend={send}
          onApprove={approve}
          onClearCache={clearCaches}
          suggestions={suggestions.map((s) => withFreshCode(s, codeSuffix))}
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
