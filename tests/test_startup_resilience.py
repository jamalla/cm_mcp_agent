"""The service must start when the engine does not answer.

This is the failure that took the deployment down: the engine sleeps on Render's
free plan and is redeployed on every registry merge, so a boot that races a cold
start gets a 502 from the platform's router. The startup connect let that
propagate, uvicorn logged "Application startup failed. Exiting.", and the
container died -- taking /healthz with it, whose whole purpose is to report
exactly this condition. A health check cannot answer "degraded" from a process
that exited.

render.yaml says it plainly: "a sleeping engine shows as degraded in the UI
instead of taking this service down with it". These tests are that sentence,
enforced.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from cm_agent.bff import app as bff
from cm_agent.bff.mcp_client import McpBridge


class _Unreachable(Exception):
    """Stands in for the 502 the platform's router returns for a cold engine."""


def test_the_app_starts_when_the_engine_is_unreachable(monkeypatch):
    """The lifespan must swallow it, not exit."""

    async def refuse() -> None:
        raise _Unreachable("502 Bad Gateway")

    monkeypatch.setattr(bff.bridge, "connect", refuse)

    with TestClient(bff.app) as client:  # __enter__ runs the lifespan
        assert client.get("/healthz").status_code == 200


def test_healthz_reports_degraded_rather_than_disappearing(monkeypatch):
    """A 200 saying "not connected" is the signal; an exited container is not."""

    async def refuse() -> None:
        raise _Unreachable("502 Bad Gateway")

    monkeypatch.setattr(bff.bridge, "connect", refuse)

    with TestClient(bff.app) as client:
        body = client.get("/healthz").json()

    assert body["ok"] is False
    assert body["mcpConnected"] is False


def test_a_failed_connect_leaves_no_half_open_client():
    """`connected` must read False, so the next call reconnects instead of using a corpse.

    The client is entered before it is stored precisely so a failure cannot leave
    a session behind that was constructed but never opened -- close() would then
    __aexit__ a context that was never entered, and one bad startup would poison
    every reconnect after it.
    """
    bridge = McpBridge(url="http://127.0.0.1:1/mcp")  # nothing listens on port 1
    assert bridge.connected is False
    assert bridge._client is None


@pytest.mark.asyncio
async def test_connect_failure_is_recoverable():
    """A refused connect must raise, reset, and stay reconnectable."""
    bridge = McpBridge(url="http://127.0.0.1:1/mcp")

    with pytest.raises(Exception):  # noqa: B017 - transport raises its own type
        await bridge.connect()

    assert bridge._client is None, "a failed connect must not leave a client behind"
    assert bridge.connected is False

    # close() on a bridge that never connected is a no-op, not a second failure.
    await bridge.close()
