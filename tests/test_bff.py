"""The BFF: prompt in, MCP call out, stage events fanned to SSE.

Runs against the stub engine over the in-memory MCP transport, so it exercises
the real decode-and-republish path without needing the engine repo or a port.
"""

import asyncio

import pytest
from fastmcp import Client

from cm_agent.bff.mcp_client import McpBridge
from tests.stub_engine import build_stub_engine


@pytest.fixture
async def bridge():
    """A bridge wired to the stub instead of a real engine endpoint."""
    bridge = McpBridge()
    stub = build_stub_engine()
    bridge._client = Client(stub, log_handler=bridge._log_handler)
    await bridge._client.__aenter__()
    try:
        yield bridge
    finally:
        await bridge._client.__aexit__(None, None, None)


async def test_stage_events_land_on_the_run_that_produced_them(bridge):
    run = bridge.create_run("run-1", "where is order ORD-123456?")
    await bridge.call_tool("get_order_status", {"orderId": "ORD-123456"}, run_id="run-1")

    types = [event.type for event in run.buffer]
    assert types == [
        "contract_selected",
        "code_generated",
        "executing",
        "result",
        "done",
    ]


async def test_the_bff_renumbers_engine_events_onto_one_timeline(bridge):
    """The BFF stamps prompt_received and routing itself, then the engine's own
    seq restarts at 0. A single ascending timeline is what lets the UI order and
    dedupe the trace."""
    run = bridge.create_run("run-2", "prompt")
    bridge.emit_local(run, "prompt_received", prompt="prompt")
    bridge.emit_local(run, "routing", chosen="lookup_shipping_zone")

    await bridge.call_tool("lookup_shipping_zone", {"countryCode": "SA"}, run_id="run-2")

    seqs = [event.seq for event in run.buffer]
    assert seqs == list(range(len(seqs))), seqs
    assert run.buffer[0].type == "prompt_received"


async def test_concurrent_runs_never_mix(bridge):
    """One MCP connection carries every run; run_id is the only separator."""
    a = bridge.create_run("A", "zone SA")
    b = bridge.create_run("B", "zone AE")

    await asyncio.gather(
        bridge.call_tool("lookup_shipping_zone", {"countryCode": "SA"}, run_id="A"),
        bridge.call_tool("lookup_shipping_zone", {"countryCode": "AE"}, run_id="B"),
    )

    assert all(event.run_id == "A" for event in a.buffer)
    assert all(event.run_id == "B" for event in b.buffer)
    assert [e.seq for e in a.buffer] == sorted(e.seq for e in a.buffer)


async def test_events_for_an_unknown_run_are_dropped_not_crashed(bridge):
    """A late or stray notification must not take the process down."""
    await bridge.call_tool("lookup_shipping_zone", {"countryCode": "SA"}, run_id="never-created")
    assert bridge.get_run("never-created") is None


async def test_proposal_carries_the_token_back(bridge):
    run = bridge.create_run("P", "cancel order ORD-777888")
    outcome = await bridge.call_tool("cancel_order", {"orderId": "ORD-777888"}, run_id="P")

    assert outcome["status"] == "proposed"
    assert outcome["approvalToken"]
    assert "proposal" in [event.type for event in run.buffer]
    assert "executing" not in [event.type for event in run.buffer]


async def test_buffer_is_ready_before_the_call_starts(bridge):
    """A browser that subscribes a beat late still replays from seq 0, because
    the run and its buffer exist before any event can be emitted."""
    run = bridge.create_run("late", "prompt")
    assert run.buffer == []
    assert bridge.get_run("late") is run
