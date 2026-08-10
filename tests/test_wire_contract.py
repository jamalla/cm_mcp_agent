"""Pins the stage-event envelope shared with cm_mcp_engine.

The two services are separate repositories with no shared package, so the only
thing holding the protocol together is that both sides agree on this literal.
The engine repo has the mirror of this file. Change the shape in one place and
one of the two goes red -- which is the point. Without it, a drift shows up as a
blank right pane in the demo and nowhere else.
"""

from cm_agent.wire import ENVELOPE_KEY, StageEvent

# Byte-for-byte what an MCP notifications/message carries for one stage.
# Keep identical to cm_mcp_engine/tests/test_wire_contract.py.
NOTIFICATION = {
    "msg": "code_generated",
    "extra": {
        "stage_event": {
            "run_id": "run-abc123",
            "seq": 3,
            "ts": 1786000000.5,
            "data": {"code": "print('hi')\n", "fromCache": False, "language": "python"},
        }
    },
}


def test_envelope_key_is_the_agreed_name():
    assert ENVELOPE_KEY == "stage_event"


def test_decodes_the_agreed_envelope():
    event = StageEvent.from_notification(NOTIFICATION["msg"], NOTIFICATION["extra"])

    assert event is not None
    assert event.run_id == "run-abc123"
    assert event.seq == 3
    assert event.type == "code_generated"
    assert event.ts == 1786000000.5
    assert event.data == {"code": "print('hi')\n", "fromCache": False, "language": "python"}


def test_payload_keys_that_collide_with_logrecord_still_arrive():
    """`args` and `message` are reserved LogRecord attributes, and both appear
    in real payloads -- the proposal and error stages. Nesting under one key is
    what makes them survive; this asserts the decoder honours that."""
    for payload in (
        {"args": {"orderId": "ORD-1"}, "action": "POST /cancel"},
        {"stage": "executing", "message": "boom"},
    ):
        event = StageEvent.from_notification(
            "proposal", {ENVELOPE_KEY: {"run_id": "r", "seq": 0, "ts": 1.0, "data": payload}}
        )
        assert event is not None
        assert event.data == payload


def test_ordinary_server_logging_is_ignored():
    """The engine also logs normally; those must not become pipeline stages."""
    assert StageEvent.from_notification("info", {"msg": "listening on :8765"}) is None
    assert StageEvent.from_notification("info", {}) is None
    assert StageEvent.from_notification("info", {ENVELOPE_KEY: "not-a-dict"}) is None


def test_sse_shape_is_what_the_browser_expects():
    event = StageEvent.from_notification(NOTIFICATION["msg"], NOTIFICATION["extra"])
    assert set(event.to_json()) == {"run_id", "seq", "type", "ts", "data"}
