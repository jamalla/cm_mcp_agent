"""Routing, and the boundary that keeps this service out of the engine."""

import ast
import pathlib

import pytest
from fastmcp import Client

from cm_agent.graph import route_prompt
from cm_agent.mcp_catalog import fetch_catalog
from tests.stub_engine import build_stub_engine


@pytest.fixture(scope="module")
async def catalog():
    async with Client(build_stub_engine()) as client:
        return await fetch_catalog(client)


def test_this_service_never_imports_the_engine():
    """The brain/hands split, now also a deployment boundary.

    cm_mcp_engine is a separate repository and a separate deployable. An import
    of its code here would make this service un-runnable without the engine's
    source and would quietly undo the split. The two talk over MCP or not at all.
    """
    package = pathlib.Path(__file__).resolve().parents[1] / "cm_agent"
    offenders: list[str] = []

    for path in package.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            for name in names:
                if name == "cm_engine" or name.startswith("cm_engine."):
                    offenders.append(f"{path.name}:{node.lineno} imports {name}")

    assert not offenders, offenders


async def test_catalog_excludes_the_engine_meta_tools(catalog):
    names = {tool.name for tool in catalog}
    assert "list_contracts" not in names
    assert "clear_caches" not in names
    assert "get_order_status" in names


@pytest.mark.parametrize(
    "prompt,expected",
    [
        ("where is order ORD-123456?", "get_order_status"),
        ("has ORD-123456 shipped yet?", "get_order_status"),
        ("what is the status of ORD-123456", "get_order_status"),
        ("cancel order ORD-777888", "cancel_order"),
        ("which shipping zone is SA in?", "lookup_shipping_zone"),
        ("can I return an item delivered 5 days ago?", "check_return_window"),
        (
            "how long does delivery take to a regional address by express?",
            "estimate_delivery_window",
        ),
    ],
)
async def test_offline_router_picks_the_right_contract(prompt, expected, catalog):
    """Without an API key the demo must still route correctly."""
    state = route_prompt(prompt, catalog)
    assert state["contract_name"] == expected, state["rationale"]
    assert not state.get("validation_errors")


async def test_offline_router_extracts_args_from_the_contract_regex(catalog):
    state = route_prompt("where is order ORD-123456?", catalog)
    assert state["args"] == {"orderId": "ORD-123456"}
    assert not state["missing_args"]


@pytest.mark.parametrize(
    "prompt", ["what is the weather in Riyadh?", "tell me a joke", "hello"]
)
async def test_router_declines_rather_than_guessing(prompt, catalog):
    state = route_prompt(prompt, catalog)
    assert state["contract_name"] is None, state["rationale"]


async def test_a_read_question_never_reaches_the_destructive_tool(catalog):
    """cancel_order's own description mentions "shipped", so a status question
    can reach it on shared vocabulary. Mis-routing a read to a write is the
    worst failure this router has, so it gets its own test."""
    for prompt in (
        "has ORD-123456 shipped yet?",
        "where is my order ORD-123456",
        "is order ORD-123456 delivered?",
    ):
        assert route_prompt(prompt, catalog)["contract_name"] != "cancel_order", prompt


async def test_routing_always_produces_a_rationale(catalog):
    """The rationale is shown on stage. It must never be blank, hit or miss."""
    for prompt in ("where is order ORD-123456?", "what is the weather?"):
        state = route_prompt(prompt, catalog)
        assert state["rationale"].strip()
        assert state["candidates"]


async def test_bad_argument_is_caught_before_the_engine_is_called(catalog):
    state = route_prompt("where is order ORD-1?", catalog)
    assert state.get("missing_args") or state.get("validation_errors")


async def test_routing_hints_survive_the_mcp_round_trip(catalog):
    """The router is only as good as the metadata the engine publishes."""
    tool = next(t for t in catalog if t.name == "get_order_status")
    assert tool.when_to_use, "whenToUse did not survive list_tools()"
    assert tool.when_not_to_use
    assert tool.rules and tool.rules[0]["field"] == "orderId"
    assert "orderId" in tool.arg_names()
    assert "run_id" not in tool.arg_names(), "run_id is engine plumbing, not a model-facing arg"
