"""The brain: prompt -> {contractName, args} + rationale. Executes nothing.

A LangGraph StateGraph with three nodes:

    load_catalog -> route -> validate_args
                      ^          |
                      +-- repair-+   (one attempt, then a clean error)

Routing happens here and nowhere else. The BFF makes the MCP `call_tool`.
This service reaches the engine only over MCP -- it never imports engine code,
and a test asserts that no such import exists.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from cm_agent import fallback_router
from cm_agent.mcp_catalog import CatalogTool

# Override with CM_ROUTER_MODEL when a better fit ships; a bad model id degrades
# to the deterministic router rather than breaking the demo.
MODEL = os.environ.get("CM_ROUTER_MODEL", "gpt-5.1")

ROUTER_SYSTEM = """You route a user's prompt to exactly one tool from a registry.

Each tool carries explicit "Use when" and "Do not use when" guidance written by
the tool's author. Those hints outrank your own intuition about what the tool
name suggests -- read them and follow them.

Rules:
- `contractName` is the tool whose OUTPUT ANSWERS THE USER -- the destination,
  never a step on the way to it. "Show me shipped orders" is answered by the
  orders tool; naming a status lookup hands back a list of statuses to someone
  who asked for orders.
- Choose exactly one tool, or null if no tool genuinely fits. Declining is a
  valid answer; a wrong tool call is worse than none.
- Fill arguments only from what the prompt actually says. Never invent an ID, a
  date, or a quantity the user did not give you.
- If a required argument is missing from the prompt, still name the tool but
  leave that argument out, and say so in your rationale.
- Give an argument the words the user actually used. Where a value has to become
  something else before it reaches the API, the tool does that itself -- pass
  "shipped", not an id you inferred. Match the TYPE the argument declares: a
  value for an "array of string" goes in a list, even when there is one of them.
- Your rationale is shown to an audience. One or two sentences on why this tool
  and not the runner-up."""

ROUTING_SCHEMA = {
    "type": "object",
    "properties": {
        "contractName": {
            "type": ["string", "null"],
            "description": "Chosen tool name, or null when nothing fits.",
        },
        # A JSON-encoded object, not an object. OpenAI's strict structured
        # outputs require `additionalProperties: false` on every object, which a
        # free-form argument bag cannot satisfy -- the arguments differ per tool,
        # so there is no fixed key set to declare. Shipping it as an object made
        # the API reject EVERY routing call with a 400, and the except-clause
        # below quietly demoted the router to the offline path. A string keeps
        # the envelope strict and confines the one parse to a single field.
        "args": {
            "type": "string",
            "description": (
                "Arguments taken from the prompt, as a JSON object encoded in a "
                'string, e.g. {"page": 2}. Use {} when the prompt states none.'
            ),
        },
        "rationale": {"type": "string", "description": "One or two sentences."},
        "candidates": {
            "type": "array",
            "description": "Tools considered, strongest first.",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "why": {"type": "string"},
                },
                "required": ["name", "why"],
                "additionalProperties": False,
            },
        },
    },
    # Strict mode requires every property to be listed here, optionality being
    # expressed by a nullable type rather than by omission.
    "required": ["contractName", "args", "rationale", "candidates"],
    "additionalProperties": False,
}


def _decode_args(raw: Any) -> dict[str, Any]:
    """Read the argument bag back out of its string.

    Tolerates a plain object too, so a model or a test that returns one still
    works. A bag that will not parse becomes empty rather than raising: the tool
    is still the right one, and an argument-less call is a recoverable answer
    where a crashed run is not.
    """
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


class AgentState(TypedDict, total=False):
    prompt: str
    catalog: list[CatalogTool]
    contract_name: str | None
    args: dict[str, Any]
    rationale: str
    candidates: list[dict[str, Any]]
    missing_args: list[str]
    validation_errors: list[str]
    repair_attempted: bool
    source: str
    error: str | None


def use_llm() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY"))


# -- nodes ---------------------------------------------------------------


def load_catalog_node(state: AgentState) -> AgentState:
    # The catalog is fetched over MCP by the caller and handed in, so this graph
    # stays synchronous and testable. See agent/mcp_catalog.py.
    if not state.get("catalog"):
        return {**state, "error": "the registry is empty; no contracts to route to"}
    return state


def _route_with_llm(state: AgentState) -> AgentState:
    from openai import OpenAI

    catalog: list[CatalogTool] = state["catalog"]
    client = OpenAI()

    tools_block = "\n\n".join(tool.routing_text() for tool in catalog)
    feedback = ""
    if errors := state.get("validation_errors"):
        feedback = (
            "\n\nYour previous attempt was rejected:\n"
            + "\n".join(f"- {e}" for e in errors)
            + "\nFix the arguments, or choose a different tool."
        )

    # strict json_schema output: the model must return exactly the routing shape,
    # so there is no free-text parsing to get wrong on stage.
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": ROUTER_SYSTEM},
            {
                "role": "user",
                "content": (
                    f"Registry:\n\n{tools_block}\n\n"
                    f"User prompt: {state['prompt']}{feedback}"
                ),
            },
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "routing_decision", "strict": True, "schema": ROUTING_SCHEMA},
        },
    )

    message = response.choices[0].message
    if getattr(message, "refusal", None):
        return {**state, "error": "the router declined to route this prompt", "source": "openai"}

    payload = json.loads(message.content)
    return {
        **state,
        "contract_name": payload.get("contractName"),
        "args": _decode_args(payload.get("args")),
        "rationale": payload.get("rationale", ""),
        "candidates": payload.get("candidates", []),
        "source": "openai",
    }


def _route_with_fallback(state: AgentState) -> AgentState:
    routing = fallback_router.route(state["prompt"], state["catalog"])
    return {
        **state,
        "contract_name": routing.contract_name,
        "args": routing.args,
        "rationale": routing.rationale,
        "candidates": [
            {"name": c.name, "why": c.why, "score": c.score} for c in routing.candidates
        ],
        "missing_args": routing.missing_args,
        "source": "fallback",
    }


def route_node(state: AgentState) -> AgentState:
    if state.get("error"):
        return state
    if not use_llm():
        return _route_with_fallback(state)
    try:
        return _route_with_llm(state)
    except Exception as exc:  # noqa: BLE001 - routing must not die on an API hiccup
        routed = _route_with_fallback(state)
        routed["rationale"] = (
            f"{routed['rationale']} (LLM router unavailable: {type(exc).__name__}.)"
        )
        return routed


_JSON_TYPES: dict[str, type | tuple[type, ...]] = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "array": list,
    "object": dict,
}


def _coerce_types(args: dict[str, Any], tool: CatalogTool) -> dict[str, Any]:
    """Widen a single value into the one-element list its argument declares.

    A router that has correctly resolved one status id and sends 1201821018
    instead of [1201821018] has made a shape mistake, not a judgement one, and
    the widening is unambiguous -- there is exactly one list that contains it.
    Worth doing rather than bouncing through a repair round trip, because the
    upstream does not error on the wrong shape; it drops the filter and returns
    everything, which is the failure that started all of this.

    Anything less clear-cut is left alone for the validation below to reject.
    """
    coerced = dict(args)
    for name, value in args.items():
        spec = tool.arg_spec(name)
        if spec.get("type") != "array" or isinstance(value, list):
            continue
        item_type = _JSON_TYPES.get((spec.get("items") or {}).get("type", ""))
        if item_type and isinstance(value, item_type) and not isinstance(value, bool):
            coerced[name] = [value]
    return coerced


def _type_errors(args: dict[str, Any], tool: CatalogTool) -> list[str]:
    """Reject a value the contract's schema would not accept.

    The engine validates too, but a mistake caught here is one the router can be
    told about and can fix on the repair pass, instead of a sandbox spawned for
    a call that cannot succeed.
    """
    errors: list[str] = []
    for name, value in args.items():
        spec = tool.arg_spec(name)
        expected = _JSON_TYPES.get(str(spec.get("type", "")))
        if expected is None:
            continue
        # bool is an int in Python; the schema does not agree.
        if isinstance(value, bool) != (spec.get("type") == "boolean"):
            errors.append(f"{name} must be {tool.arg_type(name)}")
            continue
        if not isinstance(value, expected):
            errors.append(f"{name} must be {tool.arg_type(name)}")
            continue
        if spec.get("type") == "array":
            item_type = _JSON_TYPES.get((spec.get("items") or {}).get("type", ""))
            if item_type and not all(isinstance(v, item_type) for v in value):
                errors.append(f"every item in {name} must be a {(spec['items'])['type']}")
    return errors


def validate_args_node(state: AgentState) -> AgentState:
    """Check the chosen args against the contract's schema and its regex rules.

    Catching a bad argument here means the engine never spawns a sandbox for a
    call that cannot succeed -- and the user gets a specific reason.
    """
    if state.get("error") or not state.get("contract_name"):
        return state

    tool = next((t for t in state["catalog"] if t.name == state["contract_name"]), None)
    if tool is None:
        return {
            **state,
            "validation_errors": [f"{state['contract_name']} is not in the registry"],
        }

    args = _coerce_types(state.get("args") or {}, tool)
    errors: list[str] = []

    unknown = set(args) - set(tool.arg_names())
    if unknown:
        errors.append(f"unknown argument(s): {', '.join(sorted(unknown))}")

    errors.extend(_type_errors(args, tool))

    missing = [a for a in tool.required_args if a not in args]

    for rule in tool.rules:
        field, pattern = rule.get("field"), rule.get("match")
        if field in args and pattern and not re.match(pattern, str(args[field])):
            errors.append(rule.get("message") or f"{field} does not match {pattern}")

    # `args` goes back with the coercion applied -- the BFF calls with what was
    # validated here, not with the shape the router happened to emit.
    return {**state, "args": args, "validation_errors": errors, "missing_args": missing}


def _after_validate(state: AgentState) -> str:
    if state.get("error") or not state.get("validation_errors"):
        return "done"
    if state.get("repair_attempted"):
        return "done"
    return "repair"


def repair_node(state: AgentState) -> AgentState:
    return {**state, "repair_attempted": True}


def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("load_catalog", load_catalog_node)
    graph.add_node("route", route_node)
    graph.add_node("validate_args", validate_args_node)
    graph.add_node("repair", repair_node)

    graph.set_entry_point("load_catalog")
    graph.add_edge("load_catalog", "route")
    graph.add_edge("route", "validate_args")
    graph.add_conditional_edges(
        "validate_args", _after_validate, {"repair": "repair", "done": END}
    )
    graph.add_edge("repair", "route")
    return graph.compile()


_GRAPH = None


def route_prompt(prompt: str, catalog: list[CatalogTool]) -> AgentState:
    """Run the graph. Returns the decision; executes nothing."""
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_graph()
    return _GRAPH.invoke({"prompt": prompt, "catalog": catalog})
