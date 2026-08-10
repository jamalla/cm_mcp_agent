"""The agent's view of the registry, fetched over MCP.

The agent never imports the engine. It calls `list_tools()` like any other MCP
client, so the brain/hands split from the brief is enforced by the protocol
rather than by convention -- there is no code path by which the agent could
learn a tool's binding or a secret.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Meta tools are the engine's own control surface, not partner capabilities.
# Routing to one would be a category error.
META_TOOLS = {"list_contracts", "refresh_registry", "clear_caches"}


@dataclass
class CatalogTool:
    name: str
    title: str
    description: str
    when_to_use: list[str]
    when_not_to_use: list[str]
    input_schema: dict[str, Any]
    annotations: dict[str, Any]
    rules: list[dict[str, str]]

    @property
    def required_args(self) -> list[str]:
        return [a for a in self.input_schema.get("required", []) if a != "run_id"]

    def arg_names(self) -> list[str]:
        return [a for a in self.input_schema.get("properties", {}) if a != "run_id"]

    def routing_text(self) -> str:
        """What the router reasons over."""
        lines = [f"Tool: {self.name}", f"Purpose: {self.description}"]
        if self.when_to_use:
            lines.append("Use when: " + " | ".join(self.when_to_use))
        if self.when_not_to_use:
            lines.append("Do not use when: " + " | ".join(self.when_not_to_use))
        lines.append("Arguments: " + (", ".join(self.arg_names()) or "(none)"))
        return "\n".join(lines)


def _rules_from_meta(meta: dict[str, Any]) -> list[dict[str, str]]:
    """Validation rules are not published over MCP; the fallback router mines
    the input schema's descriptions instead. Kept as a hook so a future
    contract-aware client can supply them."""
    return meta.get("validationRules", []) if meta else []


def parse_tools(mcp_tools: list[Any]) -> list[CatalogTool]:
    """Turn `list_tools()` output into the agent's routing view."""
    catalog = []
    for tool in mcp_tools:
        if tool.name in META_TOOLS:
            continue
        meta = getattr(tool, "meta", None) or {}
        catalog.append(
            CatalogTool(
                name=tool.name,
                title=getattr(tool, "title", None) or tool.name,
                description=tool.description or "",
                when_to_use=meta.get("whenToUse", []),
                when_not_to_use=meta.get("whenNotToUse", []),
                input_schema=tool.inputSchema or {},
                annotations=meta.get("governance", {}).get("annotations", {}),
                rules=_rules_from_meta(meta),
            )
        )
    return catalog


async def fetch_catalog(client) -> list[CatalogTool]:
    """`client` is a connected fastmcp.Client."""
    return parse_tools(await client.list_tools())
