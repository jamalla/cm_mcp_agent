"""Ports and the engine endpoint.

This service knows the engine only as a URL. It does not know where the engine's
source lives, what language it is written in, or how it stores contracts.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(REPO_ROOT / ".env")

# The engine's MCP endpoint. The only thing that couples the two services.
MCP_URL = os.environ.get("CM_MCP_URL", "http://127.0.0.1:8765/mcp")

BFF_HOST = os.environ.get("BFF_HOST", "127.0.0.1")
BFF_PORT = int(os.environ.get("BFF_PORT", "8000"))

FRONTEND_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "CM_FRONTEND_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",")
    if origin.strip()
]
