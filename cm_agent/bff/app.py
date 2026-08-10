"""Backend-for-frontend: agent -> MCP -> SSE.

Receives a prompt, asks the agent which contract to call, makes the MCP tool
call, and forwards every stage event to the browser on one SSE stream.

Run:  uv run uvicorn ui.bff.app:app --port 8000
"""

from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from cm_agent.graph import route_prompt, use_llm
from cm_agent.mcp_catalog import parse_tools
from cm_agent import wire as ev
from cm_agent.config import BFF_HOST, BFF_PORT, FRONTEND_ORIGINS
from cm_agent.bff.mcp_client import McpBridge, Run

bridge = McpBridge()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await bridge.connect()
    try:
        yield
    finally:
        await bridge.close()


app = FastAPI(title="Contract MCP BFF", lifespan=lifespan)

# The Vite dev server runs on a different origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    prompt: str


class ApprovalRequest(BaseModel):
    approve: bool = True


def _event_dict(event) -> dict[str, Any]:
    return {
        "run_id": event.run_id,
        "seq": event.seq,
        "type": event.type,
        "ts": event.ts,
        "data": event.data,
    }


async def _drive_run(run: Run) -> None:
    """Route the prompt, then call the tool over MCP. Emits as it goes."""
    try:
        bridge.emit_local(run, ev.PROMPT_RECEIVED, prompt=run.prompt)

        catalog = parse_tools(await bridge.list_tools())
        decision = route_prompt(run.prompt, catalog)

        bridge.emit_local(
            run,
            ev.ROUTING,
            chosen=decision.get("contract_name"),
            rationale=decision.get("rationale", ""),
            candidates=decision.get("candidates", []),
            args=decision.get("args", {}),
            source=decision.get("source", "fallback"),
            usingLlm=use_llm(),
        )

        if decision.get("error"):
            bridge.emit_local(run, ev.ERROR, stage=ev.ROUTING, message=decision["error"])
            return

        chosen = decision.get("contract_name")
        if not chosen:
            bridge.emit_local(
                run,
                ev.ERROR,
                stage=ev.ROUTING,
                message="No contract in the registry fits this prompt.",
            )
            return

        if problems := decision.get("validation_errors"):
            bridge.emit_local(
                run, ev.ERROR, stage=ev.ROUTING, message="; ".join(problems)
            )
            return

        if missing := decision.get("missing_args"):
            bridge.emit_local(
                run,
                ev.ERROR,
                stage=ev.ROUTING,
                message=(
                    f"{chosen} needs {', '.join(missing)}, which the prompt does not give."
                ),
            )
            return

        run.contract_name = chosen
        outcome = await bridge.call_tool(chosen, decision.get("args", {}), run_id=run.run_id)

        if isinstance(outcome, dict) and outcome.get("approvalToken"):
            run.approval_token = outcome["approvalToken"]

    except Exception as exc:  # noqa: BLE001 - a failed run must still end cleanly
        bridge.emit_local(run, ev.ERROR, stage="bff", message=f"{type(exc).__name__}: {exc}")
    finally:
        run.finished.set()


@app.post("/api/chat")
async def chat(request: ChatRequest) -> dict[str, str]:
    """Mint the run and its queue, then work in the background.

    Returns immediately so the browser can subscribe before events arrive --
    the queue already exists, so nothing is lost in the gap.
    """
    run_id = f"run-{uuid.uuid4().hex[:10]}"
    run = bridge.create_run(run_id, request.prompt)
    asyncio.create_task(_drive_run(run))
    return {"run_id": run_id}


@app.get("/api/stream/{run_id}")
async def stream(run_id: str) -> StreamingResponse:
    run = bridge.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id}")

    async def generator():
        sent = 0
        # Replay whatever already landed, then follow the live queue.
        while True:
            while sent < len(run.buffer):
                event = run.buffer[sent]
                sent += 1
                yield f"data: {json.dumps(_event_dict(event))}\n\n"

            if run.finished.is_set() and sent >= len(run.buffer):
                yield f"data: {json.dumps({'type': 'stream_end', 'run_id': run_id})}\n\n"
                return

            try:
                await asyncio.wait_for(run.queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/approve/{run_id}")
async def approve(run_id: str, request: ApprovalRequest) -> dict[str, Any]:
    """Second half of propose-apply: the same tool, now carrying the token."""
    run = bridge.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id}")
    if not run.approval_token or not run.contract_name:
        raise HTTPException(status_code=409, detail="this run has no pending proposal")

    if not request.approve:
        bridge.emit_local(run, ev.ERROR, stage=ev.PROPOSAL, message="Rejected by the operator.")
        return {"applied": False}

    routing = next(
        (e for e in run.buffer if e.type == ev.ROUTING), None
    )
    args = routing.data.get("args", {}) if routing else {}

    run.finished.clear()
    apply_run = bridge.create_run(f"{run_id}-apply", run.prompt)
    apply_run.contract_name = run.contract_name

    async def apply() -> None:
        try:
            await bridge.call_tool(
                run.contract_name, args, run_id=apply_run.run_id,
                approval_token=run.approval_token,
            )
        except Exception as exc:  # noqa: BLE001
            bridge.emit_local(apply_run, ev.ERROR, stage="bff", message=str(exc))
        finally:
            apply_run.finished.set()
            run.finished.set()

    asyncio.create_task(apply())
    return {"applied": True, "run_id": apply_run.run_id}


@app.get("/api/registry")
async def registry() -> Any:
    return await bridge.list_contracts()


@app.post("/api/registry/refresh")
async def registry_refresh() -> Any:
    return await bridge.refresh_registry()


@app.get("/api/contract/{name}")
async def contract(name: str) -> Any:
    try:
        return await bridge.read_contract(name)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/cache/clear")
async def cache_clear() -> Any:
    """Presenter reset between demo runs."""
    return await bridge.clear_caches()


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"ok": bridge.connected, "mcpConnected": bridge.connected, "usingLlm": use_llm()}


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=BFF_HOST, port=BFF_PORT, log_level="warning")


if __name__ == "__main__":
    main()
