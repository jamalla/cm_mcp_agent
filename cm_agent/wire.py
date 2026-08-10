"""The stage-event wire contract with cm_mcp_engine.

The engine emits pipeline stages as MCP log notifications. This module is this
repo's half of that protocol: it decodes them, and it defines the stage names
the UI renders.

**This is duplicated on purpose.** Two independently deployed services do not
share a Python package -- they share a wire format. Importing the engine's
module here would make the agent un-deployable without the engine's source and
would quietly re-couple repositories we just separated. The cost is that both
sides must agree, so both repos pin the same literal envelope in a test
(`tests/test_wire_contract.py`); if the engine ever changes the shape, one of
those two tests goes red instead of the right pane going blank.

The envelope, as it arrives inside an MCP `notifications/message`:

    {"msg": "<stage type>",
     "extra": {"stage_event": {"run_id": str, "seq": int, "ts": float,
                               "data": {...}}}}

Nested under a single key because `extra` becomes a stdlib LogRecord on the
emitting side, and LogRecord rejects reserved attribute names -- `args` and
`message` both appear in real stage payloads.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

ENVELOPE_KEY = "stage_event"

# Stages this service emits itself, because routing happens on this side of the
# MCP boundary. They share the run's single seq timeline.
#
# The engine's own stages -- contract_selected, code_generated, executing, result,
# cache_store, cache_hit, proposal, done -- are deliberately not named here. This
# service never emits them: it forwards them from the notification to the browser
# untouched, so a copy of their names here would be a second definition of a
# vocabulary this service does not own, drifting silently the moment the engine
# adds one.
PROMPT_RECEIVED = "prompt_received"
ROUTING = "routing"
ERROR = "error"


@dataclass
class StageEvent:
    run_id: str
    seq: int
    type: str
    data: dict[str, Any] = field(default_factory=dict)
    ts: float = field(default_factory=time.time)

    @classmethod
    def from_notification(cls, msg: str, extra: dict[str, Any]) -> StageEvent | None:
        """Decode one MCP log notification, or None if it is ordinary logging."""
        envelope = (extra or {}).get(ENVELOPE_KEY)
        if not isinstance(envelope, dict) or "run_id" not in envelope:
            return None
        return cls(
            run_id=envelope["run_id"],
            seq=envelope.get("seq", 0),
            type=msg,
            data=envelope.get("data") or {},
            ts=envelope.get("ts", time.time()),
        )

    def to_json(self) -> dict[str, Any]:
        """The shape the browser receives over SSE."""
        return {
            "run_id": self.run_id,
            "seq": self.seq,
            "type": self.type,
            "ts": self.ts,
            "data": self.data,
        }
