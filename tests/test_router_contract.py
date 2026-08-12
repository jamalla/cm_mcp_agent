"""What the router sends, and what it is told.

Two bugs lived here, both of which produced a confident wrong answer rather than
an error:

* The routing schema could not be accepted by the API at all, so every call
  returned 400 and the except-clause quietly demoted routing to the offline
  path. /healthz reported usingLlm true for a code path that never once ran.
* The router was never told argument TYPES, so it sent a bare value where a list
  was declared. Salla does not reject that -- it drops the filter and returns
  everything, which reads as an answer.

Value translation is NOT tested here and no longer happens here: a tool that
takes "shipped" and calls an API keyed on a store-specific id does that inside
its own generated code, where the rest of the binding lives.
"""

from __future__ import annotations

import json

import pytest

from cm_agent.graph import ROUTING_SCHEMA, _coerce_types, _decode_args, _type_errors
from cm_agent.mcp_catalog import CatalogTool


def _orders_tool() -> CatalogTool:
    return CatalogTool(
        name="list_orders",
        title="List Store Orders",
        description="Returns a paginated list of the store's orders.",
        when_to_use=["The merchant wants to see recent orders."],
        when_not_to_use=["The merchant named ONE order -- use get_order."],
        input_schema={
            "type": "object",
            "properties": {
                "page": {"type": "integer", "description": "Pagination page number."},
                "status": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Order states, named the way a person would: 'shipped'.",
                },
            },
        },
        annotations={},
        rules=[],
        dependencies=[{"contract": "list_order_statuses", "reason": "the filter resolves through it"}],
    )


# -- the schema the API will actually accept --------------------------------


def _objects(node):
    """Every object schema in the tree, including the root."""
    if isinstance(node, dict):
        if node.get("type") == "object":
            yield node
        for value in node.values():
            yield from _objects(value)
    elif isinstance(node, list):
        for item in node:
            yield from _objects(item)


def test_every_object_forbids_additional_properties():
    """The exact rule the shipped schema broke.

    OpenAI's strict structured outputs reject a schema whose objects allow extra
    keys, with a 400 on every call. It was `args` that broke it, by being a
    free-form bag -- which is why args is now a JSON-encoded string.
    """
    for schema in _objects(ROUTING_SCHEMA):
        assert schema.get("additionalProperties") is False, schema


def test_every_object_lists_all_its_properties_as_required():
    """Strict mode's other requirement; optionality is a nullable type."""
    for schema in _objects(ROUTING_SCHEMA):
        assert set(schema.get("required", [])) == set(schema.get("properties", {})), schema


def test_args_is_carried_as_a_string():
    """Arguments differ per tool, so there is no fixed key set to declare."""
    assert ROUTING_SCHEMA["properties"]["args"]["type"] == "string"


# -- reading the argument bag back ------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (json.dumps({"page": 2}), {"page": 2}),
        ("{}", {}),
        ("", {}),
        (None, {}),
        ("not json at all", {}),      # a bad bag must not crash the run
        (json.dumps([1, 2]), {}),     # nor must the wrong JSON type
        ({"page": 2}, {"page": 2}),   # a plain object is tolerated
    ],
)
def test_the_argument_bag_survives_whatever_comes_back(raw, expected):
    assert _decode_args(raw) == expected


# -- shape ------------------------------------------------------------------


def test_a_single_value_is_widened_into_the_list_its_argument_declares():
    """The right value in the wrong shape is not a near miss.

    Salla answers `status=shipped` where it wanted a list by dropping the filter
    and returning every order -- indistinguishable from a correct answer until
    someone reads the rows.
    """
    assert _coerce_types({"status": "shipped"}, _orders_tool())["status"] == ["shipped"]


def test_a_list_is_left_alone():
    tool = _orders_tool()
    assert _coerce_types({"status": ["shipped", "delivered"]}, tool)["status"] == [
        "shipped",
        "delivered",
    ]


def test_a_wrong_type_is_rejected_rather_than_rescued():
    tool = _orders_tool()
    assert _type_errors({"page": "two"}, tool)
    assert _type_errors({"status": [7]}, tool), "items are typed too"


def test_a_correct_call_raises_nothing():
    assert _type_errors({"status": ["shipped"], "page": 1}, _orders_tool()) == []


# -- what the router is shown ------------------------------------------------


def test_the_router_is_told_each_argument_s_type_and_meaning():
    """It sent a bare value because nothing ever said "array"."""
    text = _orders_tool().routing_text()
    assert "status (array of string)" in text
    assert "named the way a person would" in text, "descriptions matter as much as names"
