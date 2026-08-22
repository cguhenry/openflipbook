"""Grounded Page Contract prompt and canonical source injection."""

from __future__ import annotations

from typing import Any

from providers.searxng_grounding import GroundingSource


def compact_sources_for_prompt(sources: list[GroundingSource]) -> str:
    rows = []
    for source in sources:
        rows.append(
            f"[{source.id}] {source.title}\n"
            f"URL: {source.url}\n"
            f"Snippet: {source.snippet}"
        )
    return "\n\n".join(rows)


def grounded_planner_instruction(query: str, sources: list[GroundingSource]) -> str:
    allowed = ", ".join(source.id for source in sources) or "(none)"
    return f"""
Build PagePlan v1 for: {query}

GROUNDING SOURCES
{compact_sources_for_prompt(sources)}

Citation rules:
- factual DOM text should cite only these source IDs: {allowed}
- each text block may include source_ids: ["S1", ...]
- never invent a source ID
- never rewrite source URLs/snippets
- do not put citations or any text inside the generated image
- image scene prompt must explicitly say no text, no letters, no labels,
  no captions, no typography
- return JSON only
""".strip()


def inject_canonical_sources(
    page_plan: dict[str, Any],
    sources: list[GroundingSource],
) -> dict[str, Any]:
    """Keep only model-selected local IDs and overwrite source metadata."""

    allowed = {source.id for source in sources}
    text_blocks = page_plan.get("text_blocks")
    if isinstance(text_blocks, list):
        for block in text_blocks:
            if not isinstance(block, dict):
                continue
            raw = block.get("source_ids", [])
            if not isinstance(raw, list):
                raw = []
            clean: list[str] = []
            for value in raw:
                source_id = str(value)
                if source_id in allowed and source_id not in clean:
                    clean.append(source_id)
            block["source_ids"] = clean

    page_plan["sources"] = [source.page_contract_ref() for source in sources]
    return page_plan
