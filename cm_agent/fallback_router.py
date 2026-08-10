"""Deterministic routing for when no LLM API key is present.

Not a stub, and not optional. Acceptance criterion 5 says the demo runs offline;
the moment the agent is involved, that is only true if routing works without an
API. This scores the prompt against each contract's own whenToUse /
whenNotToUse text and extracts arguments using the contract's own validation
regexes -- so it degrades in quality, never in shape. The routing panel looks
identical either way, rationale included.

Two things make it work rather than merely run:

* **IDF weighting.** "order" appears in most of these contracts and says almost
  nothing about which one to pick; "cancel" appears in one and says everything.
  Weighting each token by how rare it is across the catalog is what stops a
  status question from routing to the cancel tool.
* **Token-anchored extraction.** A rule's regex is matched against whole tokens
  from the prompt, not searched inside them -- otherwise `^[A-Za-z]{2}$` happily
  extracts "wh" from "which".
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

from cm_agent.mcp_catalog import CatalogTool

# Only genuinely contentless words. Question words like "where" and "when" stay
# in -- they are exactly the signal that separates a status lookup from a
# delivery estimate. IDF handles anything that turns out to be common.
_STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "to",
    "of", "in", "on", "at", "for", "and", "or", "if", "it", "its", "this",
    "that", "these", "those", "with", "from", "by", "as", "my", "me", "i",
    "you", "your", "we", "us", "our", "do", "does", "did", "can", "could",
    "should", "would", "will", "has", "have", "had", "there", "any", "some",
    "about", "user", "asks", "available", "tool", "not", "no", "yet", "still",
    "already", "please", "want", "wants", "need", "needs", "get", "give",
}

_WORD = re.compile(r"[A-Za-z0-9_-]+")


def _tokens(text: str) -> set[str]:
    return {
        w.lower()
        for w in _WORD.findall(text)
        if w.lower() not in _STOPWORDS and len(w) > 2
    }


def _raw_tokens(text: str) -> list[str]:
    """Prompt tokens with original casing, for argument extraction."""
    return _WORD.findall(text)


@dataclass
class Candidate:
    name: str
    score: float
    why: str


@dataclass
class Routing:
    contract_name: str | None
    args: dict[str, Any]
    rationale: str
    candidates: list[Candidate]
    missing_args: list[str]
    source: str = "fallback"


# -- argument extraction --------------------------------------------------


def _extract_by_rules(prompt: str, tool: CatalogTool) -> dict[str, Any]:
    """Lift argument values out of the prompt using the contract's own regexes.

    `orderId` matching `^ORD-[0-9]{6,}$` means the token "ORD-123456" in the
    prompt is exactly the value the tool wants. Matching whole tokens against
    the anchored pattern -- rather than searching the stripped pattern inside
    the prompt -- is what keeps this from grabbing fragments of other words.
    """
    found: dict[str, Any] = {}
    candidates = _raw_tokens(prompt)

    for rule in tool.rules:
        field, pattern = rule.get("field"), rule.get("match")
        if not field or not pattern:
            continue
        try:
            compiled = re.compile(pattern)
        except re.error:
            continue

        matches = [tok for tok in candidates if compiled.match(tok)]
        if not matches:
            continue
        # A loose pattern like ^[A-Za-z]{2}$ matches plenty of ordinary words.
        # An explicitly-cased token ("SA") is far likelier to be the real value.
        uppercase = [m for m in matches if m.isupper()]
        found[field] = (uppercase or matches)[0]

    return found


def _enum_options(description: str) -> list[str]:
    """Options a schema description spells out, e.g. "zone: domestic, regional".

    Only text after a colon counts. Mining every noun in the description is what
    made an earlier version read "Merchant order ID." and decide the orderId was
    the literal word "order".
    """
    if ":" not in description:
        return []
    tail = description.split(":", 1)[1]
    return [
        part.strip().strip(".").lower()
        for part in re.split(r",|\bor\b", tail)
        if part.strip().strip(".")
    ]


def _extract_from_schema(prompt: str, tool: CatalogTool, taken: set[str]) -> dict[str, Any]:
    found: dict[str, Any] = {}
    lowered = prompt.lower()

    for name, spec in tool.input_schema.get("properties", {}).items():
        if name == "run_id" or name in taken:
            continue
        description = str(spec.get("description", ""))

        if spec.get("type") == "integer":
            if digits := re.search(r"\b(\d{1,4})\b", prompt):
                found[name] = int(digits.group(1))
            continue

        for option in _enum_options(description):
            if re.search(rf"\b{re.escape(option)}\b", lowered):
                found[name] = option
                break

    return found


def extract_args(prompt: str, tool: CatalogTool) -> dict[str, Any]:
    """Contract rules first; schema hints only fill what the rules did not."""
    by_rules = _extract_by_rules(prompt, tool)
    by_schema = _extract_from_schema(prompt, tool, taken=set(by_rules))
    merged = {**by_schema, **by_rules}  # rules win on conflict
    return {k: v for k, v in merged.items() if k in tool.arg_names()}


# -- scoring ---------------------------------------------------------------


def _tool_vocabulary(tool: CatalogTool) -> set[str]:
    text = " ".join(
        [tool.name.replace("_", " "), tool.description, *tool.when_to_use]
    )
    return _tokens(text)


def _idf(catalog: list[CatalogTool]) -> dict[str, float]:
    """Rarity weight per token. Common words across the catalog cannot decide."""
    total = max(len(catalog), 1)
    document_freq: dict[str, int] = {}
    for tool in catalog:
        for token in _tool_vocabulary(tool):
            document_freq[token] = document_freq.get(token, 0) + 1
    return {
        token: math.log((total + 1) / (freq + 1)) + 0.25
        for token, freq in document_freq.items()
    }


def _weighted(overlap: set[str], weights: dict[str, float]) -> float:
    return sum(weights.get(token, 1.0) for token in overlap)


def score_tool(
    prompt: str, tool: CatalogTool, weights: dict[str, float]
) -> tuple[float, str]:
    prompt_tokens = _tokens(prompt)
    reasons: list[str] = []
    score = 0.0

    # whenToUse carries the strongest signal -- it is written for exactly this.
    for hint in tool.when_to_use:
        if overlap := prompt_tokens & _tokens(hint):
            score += 3.0 * _weighted(overlap, weights)
            reasons.append(f'matches "{hint}" on {", ".join(sorted(overlap))}')

    # whenNotToUse subtracts: it exists to steer the agent away.
    for hint in tool.when_not_to_use:
        if overlap := prompt_tokens & _tokens(hint):
            score -= 2.0 * _weighted(overlap, weights)
            reasons.append(f'but "{hint}" overlaps on {", ".join(sorted(overlap))}')

    if overlap := prompt_tokens & _tokens(tool.description):
        score += 1.0 * _weighted(overlap, weights)
        reasons.append(f'description overlaps on {", ".join(sorted(overlap))}')

    if overlap := prompt_tokens & _tokens(tool.name.replace("_", " ")):
        score += 2.0 * _weighted(overlap, weights)
        reasons.append(f'name mentions {", ".join(sorted(overlap))}')

    # A destructive tool must not be reachable on vocabulary it merely shares
    # with a read-only sibling. cancel_order's own description mentions
    # "shipped", so "has ORD-123456 shipped?" would otherwise route to it.
    # Require the tool's most distinctive name token -- "cancel" -- to actually
    # be in the prompt. Mis-routing a read to a write is the worst failure this
    # router can have, so it is the one place that gets a hard gate.
    if tool.annotations.get("destructive"):
        name_tokens = _tokens(tool.name.replace("_", " "))
        if name_tokens:
            signature = max(name_tokens, key=lambda t: weights.get(t, 1.0))
            if signature not in prompt_tokens:
                score -= 25.0
                reasons.append(
                    f"destructive tool withheld: prompt never says \"{signature}\""
                )

    # A contract whose required args are present is likelier to be the intended
    # one -- but only as a tie-breaker on top of real textual intent. Alone it
    # is not evidence: "what is the weather" contains a two-letter token that a
    # country-code regex will happily match.
    by_rules = _extract_by_rules(prompt, tool)
    satisfied = [a for a in tool.required_args if a in by_rules]
    if satisfied and score > 0:
        score += 2.5 * len(satisfied)
        reasons.append(f'prompt supplies {", ".join(satisfied)}')

    return score, "; ".join(reasons) or "no overlap with this contract's hints"


def route(prompt: str, catalog: list[CatalogTool]) -> Routing:
    weights = _idf(catalog)

    scored = [
        Candidate(name=tool.name, score=round(s, 2), why=w)
        for tool in catalog
        for s, w in [score_tool(prompt, tool, weights)]
    ]
    scored.sort(key=lambda c: c.score, reverse=True)
    best = scored[0] if scored else None

    # A weak best match is a guess. Declining beats routing a weather question
    # to a shipping tool.
    if best is None or best.score < 1.0:
        return Routing(
            contract_name=None,
            args={},
            rationale=(
                "No contract's whenToUse hints match this prompt closely enough, so the "
                "agent declined to route rather than guess."
            ),
            candidates=scored[:4],
            missing_args=[],
        )

    tool = next(t for t in catalog if t.name == best.name)
    args = extract_args(prompt, tool)
    missing = [a for a in tool.required_args if a not in args]

    runner_up = scored[1] if len(scored) > 1 else None
    rationale = f"Chose {tool.name}: {best.why}."
    if runner_up:
        rationale += f" Ranked above {runner_up.name} ({best.score} vs {runner_up.score})."
    if missing:
        rationale += f" Missing required argument(s): {', '.join(missing)}."

    return Routing(
        contract_name=tool.name,
        args=args,
        rationale=rationale,
        candidates=scored[:4],
        missing_args=missing,
    )
