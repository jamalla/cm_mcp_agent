# cm_mcp_agent

**The brain, and the showcase.** Decides *which* contract answers a prompt and with *what*
arguments, calls it over MCP, and streams the whole pipeline to a two-pane UI.

It executes nothing. It reaches [`cm_mcp_engine`](../cm_mcp_engine) over MCP or not at all — there
is no import of engine code here, and [a test enforces that](tests/test_agent.py).

```
cm_agent/          LangGraph routing, offline fallback router, MCP catalog
cm_agent/wire.py   the stage-event contract with the engine
cm_agent/bff/      FastAPI: MCP client + SSE fan-out
frontend/          React + TypeScript two-pane UI
```

## Run it

```bash
uv sync --extra dev
pwsh scripts/dev.ps1          # starts a sibling cm_mcp_engine if present, then BFF + Vite
# open http://localhost:5173
pwsh scripts/dev.ps1 -Stop
```

This repo owns the demo, so its launcher will start a sibling engine checkout for you — located via
`CM_ENGINE_DIR`, defaulting to `../cm_mcp_engine`. It delegates to *that* repo's `dev.ps1` rather
than knowing how to run it. With no sibling present (`-AgentOnly`, or a deployment) it starts the
BFF and UI alone and talks to whatever `CM_MCP_URL` points at.

No API keys, no internet. Without `OPENAI_API_KEY` the deterministic offline router runs and the
UI looks identical; setting a key upgrades routing to an OpenAI model and changes nothing else.

## The demo

1. **`where is order ORD-123456?`** — the right pane lights up stage by stage: routing (with
   rationale) → contract selected (JSON) → code generated (the real source) → executing → result →
   **CACHE STORE**. About a second.
2. **Send the same prompt again** — **CACHE HIT**, single-digit milliseconds, and the trace is
   visibly *shorter*: `code_generated` and `executing` are absent, because those stages did not run.
3. **`cancel order ORD-777888`** — a destructive contract returns a proposal and mutates nothing
   until you click Approve.
4. **`how long does delivery take to a regional address by express?`** — answered by a builtin with
   no network at all.

## Routing

`cm_agent/graph.py` is a LangGraph `StateGraph`: load the catalog over MCP → route → validate
arguments, with one repair attempt. The catalog comes from `list_tools()`, so this service sees
exactly what any MCP client would — never a `binding`, never a secret.

**The offline router is load-bearing, not a stub.** Without it, "runs offline" stops being true the
moment the agent is involved. It scores prompts against each contract's own `whenToUse` /
`whenNotToUse` with IDF weighting — so vocabulary shared across contracts, like "order", cannot
decide a route — and extracts arguments using the contract's own validation regexes, matched
against whole tokens.

It also **withholds a destructive tool unless that tool's distinctive name token is in the prompt**.
`cancel_order`'s own description mentions "shipped", so *"has ORD-123456 shipped?"* would otherwise
reach it. Mis-routing a read to a write is the worst failure available here, so it is the one place
with a hard gate.

## The wire contract

The engine emits pipeline stages as MCP log notifications:

```json
{"msg": "code_generated",
 "extra": {"stage_event": {"run_id": "...", "seq": 3, "ts": 0.0, "data": {...}}}}
```

`cm_agent/wire.py` is this repo's half of that protocol, **duplicated on purpose**: two independently
deployed services share a wire format, not a Python package. Both repos pin the same literal
envelope in `tests/test_wire_contract.py`, so a drift turns a test red instead of turning the right
pane blank.

The payload is nested under one key because `extra` becomes a stdlib `LogRecord` on the emitting
side, and `LogRecord` rejects reserved attribute names — `args` and `message` both appear in real
stage payloads.

## BFF endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/chat` | mints a `run_id` and its queue, returns immediately, routes and calls in the background |
| `GET /api/stream/{run_id}` | SSE; replays the buffer then streams live |
| `POST /api/approve/{run_id}` | the second MCP call, carrying the approval token |
| `GET /api/registry`, `POST /api/registry/refresh` | proxies the engine's meta tools |
| `GET /api/contract/{name}` | reads the engine's `contract://{name}` resource |
| `POST /api/cache/clear` | presenter reset between demo runs |
| `GET /healthz` | liveness, including MCP connection state |

The run's queue is created *before* the tool call starts, so a browser that subscribes a beat late
still replays from `seq 0`. Getting that ordering wrong is the likeliest cause of a blank pane.

## Tests

```bash
uv run pytest        # 28 tests
```

Everything runs against `tests/stub_engine.py`, a stand-in that speaks the same MCP surface, so this
repo tests green with no engine anywhere. Routing quality is judged against
`tests/fixtures/catalog.json`, a pinned snapshot of the tool surface the engine publishes — it
changes deliberately, not incidentally.
