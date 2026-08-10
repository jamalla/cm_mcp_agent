"""The LLM routing path, driven by a stub client.

The offline router is covered thoroughly elsewhere. This file covers the branch a
key switches on -- the request shape, the strict-schema response, a refusal, and
the failure path back to the offline router. Without it, a typo in the OpenAI
call would first surface in front of an audience, since the branch is invisible
on any machine without a key and silently degrades on any machine with one.

No network: `openai.OpenAI` is replaced with a stub, so what is asserted is the
call this code makes, not what a model happens to answer.
"""

import json
import sys
import types

import pytest
from fastmcp import Client

from cm_agent import graph
from cm_agent.mcp_catalog import fetch_catalog
from tests.stub_engine import build_stub_engine

DECISION = {
    "contractName": "get_order_status",
    "args": {"orderId": "ORD-123456"},
    "rationale": "The prompt names one order and asks where it is.",
    "candidates": [{"name": "get_order_status", "why": "status of a named order"}],
}


class StubCompletions:
    """Records the request and returns whatever the test told it to."""

    def __init__(self, reply, raises=None):
        self.reply = reply
        self.raises = raises
        self.request = None

    def create(self, **kwargs):
        self.request = kwargs
        if self.raises:
            raise self.raises
        return self.reply


def _reply(content=None, refusal=None):
    message = types.SimpleNamespace(content=content, refusal=refusal)
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])


@pytest.fixture
def stub_openai(monkeypatch):
    """Installs a fake `openai` module and hands the test its recorder."""
    completions = StubCompletions(_reply(json.dumps(DECISION)))

    class StubClient:
        def __init__(self, *args, **kwargs):
            self.chat = types.SimpleNamespace(completions=completions)

    monkeypatch.setitem(sys.modules, "openai", types.SimpleNamespace(OpenAI=StubClient))
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-a-real-one")
    # graph.MODEL was read from the environment at import time.
    monkeypatch.setattr(graph, "MODEL", "gpt-5.1")
    return completions


@pytest.fixture(scope="module")
async def catalog():
    async with Client(build_stub_engine()) as client:
        return await fetch_catalog(client)


def test_a_key_switches_the_router_on(stub_openai, catalog):
    state = graph.route_prompt("where is order ORD-123456?", catalog)

    assert state["source"] == "openai"
    assert state["contract_name"] == "get_order_status"
    assert state["args"] == {"orderId": "ORD-123456"}
    assert state["rationale"] == DECISION["rationale"]


def test_the_request_pins_the_schema_and_carries_the_registry(stub_openai, catalog):
    graph.route_prompt("where is order ORD-123456?", catalog)
    request = stub_openai.request

    assert request["model"] == "gpt-5.1"
    # Strict json_schema output: no free text to parse, so a malformed answer is
    # the API's problem rather than a demo-time surprise.
    schema = request["response_format"]["json_schema"]
    assert schema["strict"] is True
    assert schema["schema"] == graph.ROUTING_SCHEMA

    system, user = request["messages"]
    assert system["content"] == graph.ROUTER_SYSTEM
    # The router must see the routing hints, not just tool names.
    assert "Use when" in user["content"] or "Do not use when" in user["content"]
    assert "where is order ORD-123456?" in user["content"]


def test_a_refusal_is_reported_not_guessed_around(stub_openai, catalog):
    stub_openai.reply = _reply(content=None, refusal="I will not route this.")

    state = graph.route_prompt("do something questionable", catalog)

    assert state["error"]
    assert state["source"] == "openai"


def test_an_api_failure_degrades_to_the_offline_router(stub_openai, catalog):
    """A hiccup mid-demo must cost quality, never the demo."""
    stub_openai.raises = RuntimeError("connection reset")

    state = graph.route_prompt("where is order ORD-123456?", catalog)

    assert state["source"] == "fallback"
    assert state["contract_name"] == "get_order_status"
    assert "LLM router unavailable: RuntimeError" in state["rationale"]


def test_without_a_key_the_llm_is_never_called(monkeypatch, catalog):
    monkeypatch.setenv("OPENAI_API_KEY", "")

    state = graph.route_prompt("where is order ORD-123456?", catalog)

    assert state["source"] == "fallback"
