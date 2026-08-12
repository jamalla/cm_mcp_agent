"""One prompt, two calls: resolve a store-specific id before filtering on it.

"list recent shipped orders" used to return every recent order. The word
"shipped" names a state, but the filter takes an id that belongs to this
merchant's store -- 1201821018 here, a different number in the next store. No
router can know it, so the old router filled nothing, the call went out
unfiltered, and fifteen orders in five different states came back looking like
an answer.

The contracts already declared the edge: list_orders depends on
list_order_statuses, "the status filter takes this store's own status ids". It
was documentation nothing could act on. These tests are it being acted on.
"""

from __future__ import annotations

import pytest

from cm_agent import fallback_router
from cm_agent.mcp_catalog import CatalogTool

# Shaped like the real /orders/statuses payload, down to the duplicate slug: a
# parent state and a merchant's custom child share one, which is exactly why a
# slug cannot be the thing sent to the filter.
STATUS_ROWS = {
    "items": [
        {"id": 1201821018, "name": "تم الشحن", "slug": "shipped",
         "translations": {"en": {"name": "Shipped"}}, "parent": None},
        {"id": 1975858777, "name": "تم التوصيل", "slug": "delivered",
         "translations": {"en": {"name": "Delivered"}}, "parent": None},
        {"id": 1351396188, "name": "بإنتظار المراجعة", "slug": "under_review",
         "translations": {"en": {"name": "Waiting Review"}}, "parent": None},
        {"id": 654146602, "name": "Ai Agent Not Confirmed", "slug": "under_review",
         "translations": {}, "parent": {"id": 1351396188}},
    ]
}


def _orders_tool() -> CatalogTool:
    return CatalogTool(
        name="list_orders",
        title="List Store Orders",
        description="Returns a paginated list of the store's orders.",
        when_to_use=["The merchant wants to see recent orders, e.g. 'show me my latest orders'."],
        when_not_to_use=["The merchant named ONE order -- use get_order."],
        input_schema={
            "type": "object",
            "properties": {
                "page": {"type": "integer", "description": "Pagination page number."},
                "status": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": (
                        "This store's own status ids -- the id of a row from "
                        "list_order_statuses. NOT slugs and NOT names."
                    ),
                },
            },
        },
        annotations={},
        rules=[],
        dependencies=[
            {"contract": "list_order_statuses", "reason": "the status filter takes store ids"}
        ],
    )


def _statuses_tool() -> CatalogTool:
    return CatalogTool(
        name="list_order_statuses",
        title="List Order Statuses",
        description="Returns every order state this store uses.",
        when_to_use=["A merchant names an order state in words and another tool needs its id."],
        when_not_to_use=["The merchant wants the orders themselves -- use list_orders."],
        input_schema={"type": "object", "properties": {}},
        annotations={},
        rules=[],
        dependencies=[],
    )


CATALOG = [_orders_tool(), _statuses_tool()]


# -- pass one: ask for the lookup -----------------------------------------


def test_the_first_pass_asks_for_the_lookup_instead_of_guessing():
    routing = fallback_router.route("list recent shipped orders", CATALOG)

    assert routing.contract_name == "list_orders"
    assert routing.needs_lookup == "list_order_statuses"
    assert "status" not in routing.args, "an unresolvable id must not be invented"


def test_a_prompt_needing_no_lookup_does_not_ask_for_one():
    """The hop is not free, so it must not fire on every orders question."""
    routing = fallback_router.route("show me my latest orders", CATALOG)

    assert routing.contract_name == "list_orders"
    assert routing.needs_lookup is None


# -- pass two: read the id out of the rows --------------------------------


def test_the_second_pass_resolves_the_id_from_the_rows():
    routing = fallback_router.route(
        "list recent shipped orders", CATALOG, lookup_results=STATUS_ROWS
    )

    assert routing.args.get("status") == [1201821018]
    assert routing.needs_lookup is None, "one hop only"


def test_it_resolves_through_a_translation():
    """`name` is Arabic; the merchant typed English. The row still matches."""
    routing = fallback_router.route(
        "which orders are delivered", CATALOG, lookup_results=STATUS_ROWS
    )

    assert routing.args.get("status") == [1975858777]


def test_a_state_the_store_does_not_have_resolves_to_nothing():
    """Better an unfiltered answer the rationale admits to than a wrong id."""
    routing = fallback_router.route(
        "list recent refunded orders", CATALOG, lookup_results=STATUS_ROWS
    )

    assert "status" not in routing.args
    assert "returned nothing matching" in routing.rationale


def test_matching_is_whole_token_not_substring():
    """"delivered" must not also drag in "delivering", or one state becomes two."""
    rows = {"items": [
        {"id": 1, "slug": "delivered"},
        {"id": 2, "slug": "delivering"},
    ]}
    routing = fallback_router.route("orders delivered", CATALOG, lookup_results=rows)

    assert routing.args.get("status") == [1]


# -- the guard rail --------------------------------------------------------


def test_a_lookup_the_contract_does_not_declare_is_refused():
    """The dependency array is the allowlist, so a confused router cannot
    nominate an arbitrary tool -- a write, say -- as a precondition."""
    from cm_agent.graph import _valid_lookup

    assert _valid_lookup("list_order_statuses", "list_orders", CATALOG) == "list_order_statuses"
    assert _valid_lookup("delete_everything", "list_orders", CATALOG) is None
    assert _valid_lookup("list_order_statuses", "list_order_statuses", CATALOG) is None


@pytest.mark.parametrize(
    "payload",
    [STATUS_ROWS, STATUS_ROWS["items"], {"data": STATUS_ROWS["items"]}],
)
def test_rows_are_found_whatever_envelope_they_arrive_in(payload):
    routing = fallback_router.route(
        "list recent shipped orders", CATALOG, lookup_results=payload
    )
    assert routing.args.get("status") == [1201821018]


# -- argument shape --------------------------------------------------------
#
# The right id in the wrong shape is not a near miss. Salla does not reject
# `status=1201821018` where it wanted a list -- it drops the filter and returns
# every order, which is indistinguishable from a correct answer until someone
# reads the rows. A router observed doing exactly this is why these exist.


def test_a_single_id_is_widened_into_the_list_the_contract_declares():
    from cm_agent.graph import _coerce_types

    coerced = _coerce_types({"status": 1201821018}, _orders_tool())
    assert coerced["status"] == [1201821018]


def test_a_list_is_left_alone():
    from cm_agent.graph import _coerce_types

    coerced = _coerce_types({"status": [1, 2]}, _orders_tool())
    assert coerced["status"] == [1, 2]


def test_a_scalar_of_the_wrong_item_type_is_not_widened_but_rejected():
    """Widening is for shape mistakes. A string where ids belong is a real error."""
    from cm_agent.graph import _coerce_types, _type_errors

    tool = _orders_tool()
    coerced = _coerce_types({"status": "shipped"}, tool)
    assert coerced["status"] == "shipped", "no silent rescue of a wrong-typed value"
    assert any("status" in e for e in _type_errors(coerced, tool))


def test_a_list_of_slugs_is_rejected():
    """The exact call the old contract described: [\"shipped\"] instead of ids."""
    from cm_agent.graph import _type_errors

    errors = _type_errors({"status": ["shipped"]}, _orders_tool())
    assert any("integer" in e for e in errors), errors


def test_a_correct_call_raises_no_type_errors():
    from cm_agent.graph import _type_errors

    assert _type_errors({"status": [1201821018], "page": 1}, _orders_tool()) == []


def test_the_router_is_told_each_argument_s_type():
    """It sent a bare id because nothing ever said "array"."""
    text = _orders_tool().routing_text()
    assert "status (array of integer)" in text
    assert "list_order_statuses" in text, "the dependency must be visible too"
