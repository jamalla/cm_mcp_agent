"""A stand-in for cm_mcp_engine, built from this repo's own fixtures.

The agent must be testable in a clone of this repository alone -- CI has no
engine next door, and depending on one would re-couple the two services we
deliberately split.

So these tests run against a stub that speaks the same MCP surface: tools whose
descriptions and `meta` carry routing hints, and handlers that emit stage events
in the documented envelope. If the real engine ever drifts from that surface,
`tests/test_wire_contract.py` is what catches it -- not this file.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from fastmcp import FastMCP
from fastmcp.server.dependencies import get_context
from fastmcp.tools import FunctionTool
from mcp.types import ToolAnnotations

from cm_agent.wire import ENVELOPE_KEY

FIXTURE = Path(__file__).parent / "fixtures" / "catalog.json"


def _describe(tool: dict[str, Any]) -> str:
    parts = [tool["description"]]
    if hints := tool.get("whenToUse"):
        parts.append("\n\nUse this when:\n" + "\n".join(f"- {h}" for h in hints))
    if hints := tool.get("whenNotToUse"):
        parts.append("\n\nDo not use this when:\n" + "\n".join(f"- {h}" for h in hints))
    return "".join(parts)


async def _emit(run_id: str, seq: int, event_type: str, **data: Any) -> None:
    ctx = get_context()
    await ctx.info(
        event_type,
        extra={
            ENVELOPE_KEY: {
                "run_id": run_id,
                "seq": seq,
                "ts": time.time(),
                "data": data,
            }
        },
    )


def _build_tool(spec: dict[str, Any]) -> FunctionTool:
    async def handler(**kwargs: Any) -> dict[str, Any]:
        run_id = kwargs.pop("run_id", "stub-run")
        approval_token = kwargs.pop("approval_token", None)

        await _emit(run_id, 0, "contract_selected", contractName=spec["name"], version="1.0.0")

        if spec.get("annotations", {}).get("destructive") and not approval_token:
            await _emit(run_id, 1, "proposal", action=f"{spec['name']}({kwargs})",
                        approvalToken="stub-token", reason="Approval required.")
            await _emit(run_id, 2, "done", durationMs=1, proposed=True)
            return {"status": "proposed", "output": None, "approvalToken": "stub-token",
                    "cached": False, "durationMs": 1, "error": None}

        await _emit(run_id, 1, "code_generated", code="# stub\n", fromCache=False)
        await _emit(run_id, 2, "executing", tool=spec["name"])
        output = {**kwargs, "stub": True}
        await _emit(run_id, 3, "result", output=output, uiHint=spec.get("responseUi"))
        await _emit(run_id, 4, "done", durationMs=7, cached=False)
        return {"status": "ok", "output": output, "cached": False, "durationMs": 7,
                "error": None, "approvalToken": None}

    schema = json.loads(json.dumps(spec["inputSchema"]))
    schema.setdefault("properties", {})["run_id"] = {"type": "string"}
    if spec.get("annotations", {}).get("destructive"):
        schema["properties"]["approval_token"] = {"type": "string"}

    annotations = spec.get("annotations", {})
    return FunctionTool(
        name=spec["name"],
        title=spec.get("title", spec["name"]),
        description=_describe(spec),
        parameters=schema,
        annotations=ToolAnnotations(
            readOnlyHint=annotations.get("readOnly", False),
            destructiveHint=annotations.get("destructive", False),
        ),
        meta={
            "contractVersion": "1.0.0",
            "package": spec.get("package"),
            "whenToUse": spec.get("whenToUse", []),
            "whenNotToUse": spec.get("whenNotToUse", []),
            "validationRules": spec.get("validationRules", []),
            "governance": {"annotations": annotations},
            "responseUi": spec.get("responseUi"),
        },
        fn=handler,
    )


def build_stub_engine() -> FastMCP:
    specs = json.loads(FIXTURE.read_text(encoding="utf-8"))["tools"]
    mcp = FastMCP("stub-engine", tools=[_build_tool(spec) for spec in specs])

    @mcp.tool
    async def list_contracts() -> dict[str, Any]:
        """List every approved contract."""
        return {"tools": specs, "warnings": [], "source": {"kind": "stub"}}

    @mcp.tool
    async def clear_caches() -> dict[str, Any]:
        """Drop both cache layers."""
        return {"cleared": True}

    @mcp.tool
    async def refresh_registry() -> dict[str, Any]:
        """Re-read contracts from disk."""
        return {"toolCount": len(specs), "warnings": []}

    return mcp
