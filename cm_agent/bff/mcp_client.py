"""The bridge: one MCP client, a log_handler, and a queue per run.

Stage events reach us as MCP log notifications during a tool call. The handler
decodes each into a StageEvent and drops it on the queue for that event's
run_id, which the SSE endpoint is draining.

The queue is created when the run is created -- before the tool call starts --
so a browser that subscribes a beat late still replays from seq 0. Getting that
ordering wrong is the likeliest cause of a blank right pane.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport

from cm_agent.config import MCP_URL
from cm_agent.wire import StageEvent


@dataclass
class Run:
    run_id: str
    prompt: str
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    buffer: list[StageEvent] = field(default_factory=list)
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    approval_token: str | None = None
    contract_name: str | None = None

    def publish(self, event: StageEvent) -> None:
        self.buffer.append(event)
        self.queue.put_nowait(event)


class McpBridge:
    """Holds the long-lived MCP connection and routes notifications to runs."""

    def __init__(self, url: str | None = None) -> None:
        self._url = url or MCP_URL
        self._client: Client | None = None
        self._runs: dict[str, Run] = {}

    # -- lifecycle --------------------------------------------------------

    async def connect(self) -> None:
        transport = StreamableHttpTransport(url=self._url)
        self._client = Client(transport, log_handler=self._log_handler, timeout=120)
        await self._client.__aenter__()

    async def close(self) -> None:
        if self._client is not None:
            await self._client.__aexit__(None, None, None)
            self._client = None

    @property
    def connected(self) -> bool:
        return self._client is not None and self._client.is_connected()

    @property
    def client(self) -> Client:
        if self._client is None:
            raise RuntimeError("MCP bridge is not connected")
        return self._client

    # -- runs -------------------------------------------------------------

    def create_run(self, run_id: str, prompt: str) -> Run:
        run = Run(run_id=run_id, prompt=prompt)
        self._runs[run_id] = run
        return run

    def get_run(self, run_id: str) -> Run | None:
        return self._runs.get(run_id)

    def forget(self, run_id: str) -> None:
        self._runs.pop(run_id, None)

    def emit_local(self, run: Run, event_type: str, **data: Any) -> StageEvent:
        """Publish an event the BFF itself produces (prompt_received, routing).

        Routing happens in the agent, on this side of the MCP boundary, so those
        stages are stamped here and share the same seq space as the engine's.
        """
        event = StageEvent(
            run_id=run.run_id, seq=len(run.buffer), type=event_type, data=data
        )
        run.publish(event)
        return event

    # -- the carrier ------------------------------------------------------

    async def _log_handler(self, message) -> None:
        """Decode one MCP log notification into a StageEvent.

        FastMCP's structured logger delivers `data` as
        {"msg": <event type>, "extra": <payload>}.
        """
        data = message.data
        if not isinstance(data, dict):
            return

        event = StageEvent.from_notification(data.get("msg", ""), data.get("extra") or {})
        if event is None:
            return  # ordinary server logging, not a stage event

        run = self._runs.get(event.run_id)
        if run is None:
            return

        # The engine's seq restarts at 0 per call; the BFF has already stamped
        # prompt_received and routing. Renumber onto the run's single timeline.
        event.seq = len(run.buffer)
        run.publish(event)

    # -- calls ------------------------------------------------------------

    async def call_tool(
        self, name: str, args: dict[str, Any], *, run_id: str, approval_token: str | None = None
    ) -> Any:
        payload = {**args, "run_id": run_id}
        if approval_token:
            payload["approval_token"] = approval_token
        result = await self.client.call_tool(name, payload)
        return result.data

    async def list_contracts(self) -> Any:
        result = await self.client.call_tool("list_contracts", {})
        return result.data

    async def refresh_registry(self) -> Any:
        result = await self.client.call_tool("refresh_registry", {})
        return result.data

    async def clear_caches(self) -> Any:
        result = await self.client.call_tool("clear_caches", {})
        return result.data

    async def read_contract(self, name: str) -> Any:
        import json

        contents = await self.client.read_resource(f"contract://{name}")
        return json.loads(contents[0].text)

    async def list_tools(self):
        return await self.client.list_tools()
