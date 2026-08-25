import { useCallback, useRef, useState } from 'react'
import type { StageEvent } from './types'

/**
 * Subscribes to one run's SSE stream and collects its stage events in seq order.
 *
 * The BFF creates the run's queue before the tool call starts and replays its
 * buffer on connect, so subscribing a beat after POST /api/chat loses nothing.
 */
export function useEventStream() {
  const [events, setEvents] = useState<StageEvent[]>([])
  const [running, setRunning] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)

  const stop = useCallback(() => {
    sourceRef.current?.close()
    sourceRef.current = null
    setRunning(false)
  }, [])

  const start = useCallback(
    (runId: string, onEvent?: (event: StageEvent) => void) =>
      new Promise<void>((resolve) => {
        sourceRef.current?.close()
        setEvents([])
        setRunning(true)

        const source = new EventSource(`/api/stream/${runId}`)
        sourceRef.current = source

        source.onmessage = (message) => {
          const event = JSON.parse(message.data) as StageEvent
          if (event.type === 'stream_end') {
            source.close()
            sourceRef.current = null
            setRunning(false)
            resolve()
            return
          }
          setEvents((prior) => {
            // Guard against a duplicate delivery reordering the trace.
            if (prior.some((e) => e.seq === event.seq)) return prior
            return [...prior, event].sort((a, b) => a.seq - b.seq)
          })
          onEvent?.(event)
        }

        source.onerror = () => {
          source.close()
          sourceRef.current = null
          setRunning(false)
          resolve()
        }
      }),
    [],
  )

  const append = useCallback((extra: StageEvent[]) => {
    setEvents((prior) => [...prior, ...extra])
  }, [])

  /** Drop the collected trace. Starting a new conversation should not leave the
   *  previous run's stages sitting beside an empty chat. */
  const clear = useCallback(() => {
    setEvents([])
  }, [])

  return { events, running, start, stop, append, clear }
}
