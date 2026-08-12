"""The agent's view of the registry, fetched over MCP.

The agent never imports the engine. It calls `list_tools()` like any other MCP
client, so the brain/hands split from the brief is enforced by the protocol
rather than by convention -- there is no code path by which the agent could
learn a tool's binding or a secret.
"""

from __future__ import annotations

from dataclasses import dataclass, field
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
    dependencies: list[dict[str, str]] = field(default_factory=list)

    @property
    def required_args(self) -> list[str]:
        return [a for a in self.input_schema.get("required", []) if a != "run_id"]

    def arg_names(self) -> list[str]:
        return [a for a in self.input_schema.get("properties", {}) if a != "run_id"]

    def arg_description(self, name: str) -> str:
        spec = self.input_schema.get("properties", {}).get(name) or {}
        return str(spec.get("description", ""))

    def arg_spec(self, name: str) -> dict[str, Any]:
        return self.input_schema.get("properties", {}).get(name) or {}

    def arg_type(self, name: str) -> str:
        """The argument's type, spelled out for a reader.

        A router told only "status" sends 1201821018 where the contract wants
        [1201821018] -- correct value, wrong shape, and the upstream treats it
        as no filter at all.
        """
        spec = self.arg_spec(name)
        declared = spec.get("type")
        if declared == "array":
            item = (spec.get("items") or {}).get("type")
            return f"array of {item}" if item else "array"
        return str(declared) if declared else ""

    def routing_text(self) -> str:
        """What the router reasons over."""
        lines = [f"Tool: {self.name}", f"Purpose: {self.description}"]
        if self.when_to_use:
            lines.append("Use when: " + " | ".join(self.when_to_use))
        if self.when_not_to_use:
            lines.append("Do not use when: " + " | ".join(self.when_not_to_use))

        # Argument descriptions, not just names. A router told only that
        # list_orders takes "status" will guess a word; told that status takes
        # ids that list_order_statuses supplies, it can ask for the lookup
        # instead of inventing one. This is the whole reason a wrong-typed
        # filter used to sail through as an empty filter.
        args = self.arg_names()
        if args:
            lines.append("Arguments:")
            for name in args:
                label = f"{name} ({t})" if (t := self.arg_type(name)) else name
                description = self.arg_description(name)
                lines.append(f"  - {label}: {description}" if description else f"  - {label}")
        else:
            lines.append("Arguments: (none)")

        if edges := [d for d in self.dependencies if d.get("contract")]:
            lines.append(
                "Depends on: "
                + " | ".join(
                    f"{d['contract']} -- {d.get('reason', '')}".strip(" -") for d in edges
                )
            )
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
                dependencies=meta.get("dependencies", []),
            )
        )
    return catalog


async def fetch_catalog(client) -> list[CatalogTool]:
    """`client` is a connected fastmcp.Client."""
    return parse_tools(await client.list_tools())
