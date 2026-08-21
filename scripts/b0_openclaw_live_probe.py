#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
BACKEND_ROOT = REPO_ROOT / "apps" / "modal-backend"
sys.path.insert(0, str(BACKEND_ROOT))

from providers.openclaw_contract import (
    OpenClawContractError,
    assert_provider_model,
    build_rendered_page,
    check_center_resolver,
    extract_json_object_from_envelope,
    image_output_path,
    validate_alignment_minimal,
    validate_page_plan_minimal,
)

STAGES = ("planner", "image", "aligner")
TEXT_MODEL = "openai/gpt-5.4-mini"
IMAGE_MODEL = "openai/gpt-image-2"

PLANNER_PROMPT = """Return JSON only. Build one visual learning page for: 蒸汽機如何運作

Use Traditional Chinese. Keep output compact.

Exact shape:
{
  "schema_version":"1.0",
  "title":"...",
  "summary":"...",
  "scene":{"prompt":"...","style":"...","aspect_ratio":"16:9"},
  "text_blocks":[
    {"id":"t001","role":"title","text":"...","anchor":"top-left"},
    {"id":"t002","role":"body","text":"...","anchor":"bottom-left"}
  ],
  "hotspots":[
    {"id":"h001","label":"...","sub_query":"...","visual_target":"...","desired_bbox":[x,y,w,h]},
    {"id":"h002","label":"...","sub_query":"...","visual_target":"...","desired_bbox":[x,y,w,h]},
    {"id":"h003","label":"...","sub_query":"...","visual_target":"...","desired_bbox":[x,y,w,h]}
  ],
  "motion_hints":[],
  "sources":[]
}

Rules:
- exactly 2 text_blocks and exactly 3 hotspots
- every bbox number is 0..1
- scene.prompt describes a clear educational cutaway illustration
- scene.prompt MUST explicitly say: no text, no letters, no labels, no captions, no typography
- do not place words inside the illustration
- no markdown fences, commentary, citations, or extra keys"""

ALIGNMENT_PROMPT = """Return JSON only.

Locate these three visual targets in the supplied generated image:
{TARGETS}

Output exactly:
{
  "hotspots":[
    {"id":"h001","bbox":[x,y,w,h],"confidence":0.0},
    {"id":"h002","bbox":[x,y,w,h],"confidence":0.0},
    {"id":"h003","bbox":[x,y,w,h],"confidence":0.0}
  ]
}

Coordinates are normalized to the whole image: x,y,w,h each 0..1.
Use the exact input hotspot IDs once each.
bbox should tightly cover the visible target.
confidence is 0..1.
No polygons, no explanations, no markdown fences, no extra keys."""

_SECRET_PATTERN = re.compile(r"\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b")


def atomic_json(path: Path, value: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def redact(text: str) -> str:
    return _SECRET_PATTERN.sub("[REDACTED]", text)


def load_ledger(path: Path) -> dict[str, Any]:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {
        "schema_version": 1,
        "created_at_epoch": time.time(),
        "stages": {name: {"state": "not_started"} for name in STAGES},
    }


def save_ledger(path: Path, ledger: dict[str, Any]) -> None:
    atomic_json(path, ledger)


def refuse_reexecution(ledger: dict[str, Any]) -> None:
    touched = [
        (name, ledger["stages"][name]["state"])
        for name in STAGES
        if ledger["stages"][name]["state"] != "not_started"
    ]
    if touched:
        raise SystemExit(
            "REFUSING LIVE RE-RUN: ledger already contains attempted stages: "
            + ", ".join(f"{name}={state}" for name, state in touched)
        )


def command_env() -> dict[str, str]:
    env = os.environ.copy()
    # The operator must verify OAuth-only auth order before executing this probe.
    # Removing ambient key variables prevents an accidental env-key route.
    env.pop("OPENAI_API_KEY", None)
    env.pop("CODEX_API_KEY", None)
    return env


def run_stage(
    name: str,
    command: list[str],
    *,
    out_dir: Path,
    ledger_path: Path,
    ledger: dict[str, Any],
) -> dict[str, Any]:
    row = ledger["stages"][name]
    if row["state"] != "not_started":
        raise SystemExit(f"REFUSING stage {name}: ledger state is {row['state']!r}")

    row.update({"state": "started", "started_at_epoch": time.time(), "argv": command})
    save_ledger(ledger_path, ledger)

    try:
        completed = subprocess.run(
            command,
            text=True,
            capture_output=True,
            env=command_env(),
            check=False,
        )
    except OSError as exc:
        safe_error = redact(str(exc))[:500]
        row.update(
            {
                "state": "failed",
                "finished_at_epoch": time.time(),
                "returncode": None,
                "safe_error": safe_error,
            }
        )
        save_ledger(ledger_path, ledger)
        raise SystemExit(f"LIVE_STAGE_FAILED={name}; no automatic retry is permitted") from exc

    stdout = redact(completed.stdout)
    stderr = redact(completed.stderr)
    (out_dir / f"{name}.stdout.txt").write_text(stdout, encoding="utf-8")
    (out_dir / f"{name}.stderr.txt").write_text(stderr, encoding="utf-8")

    try:
        envelope = json.loads(completed.stdout)
    except json.JSONDecodeError:
        envelope = {
            "ok": False,
            "error": "stdout was not valid JSON",
            "_stdout_preview": stdout[:500],
        }
    atomic_json(out_dir / f"{name}-envelope.json", envelope)

    if completed.returncode != 0 or envelope.get("ok") is not True:
        safe_error = str(envelope.get("error") or stderr[:500])
        row.update(
            {
                "state": "failed",
                "finished_at_epoch": time.time(),
                "returncode": completed.returncode,
                "safe_error": redact(safe_error)[:500],
            }
        )
        save_ledger(ledger_path, ledger)
        raise SystemExit(f"LIVE_STAGE_FAILED={name}; no automatic retry is permitted")

    row.update(
        {
            "state": "completed",
            "finished_at_epoch": time.time(),
            "returncode": completed.returncode,
            "provider": envelope.get("provider"),
            "model": envelope.get("model"),
            "attempts": envelope.get("attempts"),
        }
    )
    save_ledger(ledger_path, ledger)
    return envelope


def targets_text(plan: dict[str, Any]) -> str:
    return "\n".join(
        f'{hotspot["id"]}: {hotspot["label"]} — {hotspot["visual_target"]}'
        for hotspot in plan["hotspots"]
    )


def planner_command(text_model: str) -> list[str]:
    return [
        "openclaw",
        "infer",
        "model",
        "run",
        "--local",
        "--model",
        text_model,
        "--thinking",
        "off",
        "--prompt",
        PLANNER_PROMPT,
        "--json",
    ]


def image_command(image_model: str, output: Path, prompt: str) -> list[str]:
    return [
        "openclaw",
        "infer",
        "image",
        "generate",
        "--model",
        image_model,
        "--quality",
        "low",
        "--count",
        "1",
        "--background",
        "opaque",
        "--openai-moderation",
        "low",
        "--size",
        "1536x1024",
        "--output",
        str(output),
        "--prompt",
        prompt,
        "--json",
    ]


def alignment_command(text_model: str, image: Path, prompt: str) -> list[str]:
    return [
        "openclaw",
        "infer",
        "model",
        "run",
        "--local",
        "--model",
        text_model,
        "--thinking",
        "off",
        "--file",
        str(image),
        "--prompt",
        prompt,
        "--json",
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-dir", required=True)
    parser.add_argument("--text-model", default=TEXT_MODEL)
    parser.add_argument("--image-model", default=IMAGE_MODEL)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--execute-live", action="store_true")
    args = parser.parse_args()

    if args.dry_run == args.execute_live:
        parser.error("choose exactly one of --dry-run or --execute-live")
    if args.text_model != TEXT_MODEL or args.image_model != IMAGE_MODEL:
        parser.error("B0 model pins are fixed to gpt-5.4-mini and gpt-image-2")

    out_dir = Path(args.results_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    ledger_path = out_dir / "call-ledger.json"
    ledger = load_ledger(ledger_path)
    planner_cmd = planner_command(args.text_model)

    if args.dry_run:
        refuse_reexecution(ledger)
        image_placeholder = out_dir / "b0-page.png"
        image_prompt = "<planner scene.prompt + hard no-text/opaque-background suffix>"
        alignment_placeholder = out_dir / "b0-page.png"
        alignment_prompt = "<alignment template + 3 targets>"
        commands = [
            planner_cmd,
            image_command(args.image_model, image_placeholder, image_prompt),
            alignment_command(args.text_model, alignment_placeholder, alignment_prompt),
        ]
        if any("--probe" in command for command in commands):
            raise OpenClawContractError("B0 command unexpectedly contains --probe")
        print("B0_DRY_RUN_CALL_BUDGET=3")
        for index, command in enumerate(commands, start=1):
            print(f"CALL{index}", shlex.join(command))
        print("B0_DRY_RUN_NO_LIVE_CALLS=true")
        return 0

    refuse_reexecution(ledger)

    planner_envelope = run_stage(
        "planner",
        planner_cmd,
        out_dir=out_dir,
        ledger_path=ledger_path,
        ledger=ledger,
    )
    assert_provider_model(
        planner_envelope,
        provider="openai",
        model_contains=args.text_model.split("/", 1)[1],
    )
    plan = validate_page_plan_minimal(extract_json_object_from_envelope(planner_envelope))
    atomic_json(out_dir / "page-plan.json", plan)

    hard_no_text = (
        " No text. No letters. No labels. No captions. No typography."
        " Do not render any written language inside the illustration."
        " No transparent background; use an opaque background."
    )
    scene_prompt = str(plan["scene"]["prompt"]).strip() + hard_no_text
    requested_image = out_dir / "b0-page.png"
    image_envelope = run_stage(
        "image",
        image_command(args.image_model, requested_image, scene_prompt),
        out_dir=out_dir,
        ledger_path=ledger_path,
        ledger=ledger,
    )
    assert_provider_model(image_envelope, provider="openai", model_contains="gpt-image-2")
    generated = image_output_path(image_envelope)
    if not generated.is_absolute():
        generated = (Path.cwd() / generated).resolve()
    if not generated.exists() or generated.stat().st_size <= 0:
        raise OpenClawContractError(f"generated image missing/empty: {generated}")
    try:
        with Image.open(generated) as image:
            image.verify()
            image_width, image_height = image.size
    except Exception as exc:
        raise OpenClawContractError(f"generated image is not readable: {generated}") from exc

    align_prompt = ALIGNMENT_PROMPT.replace("{TARGETS}", targets_text(plan))
    align_envelope = run_stage(
        "aligner",
        alignment_command(args.text_model, generated, align_prompt),
        out_dir=out_dir,
        ledger_path=ledger_path,
        ledger=ledger,
    )
    assert_provider_model(
        align_envelope,
        provider="openai",
        model_contains=args.text_model.split("/", 1)[1],
    )
    alignment_payload = extract_json_object_from_envelope(align_envelope)
    expected_ids = [hotspot["id"] for hotspot in plan["hotspots"]]
    aligned = validate_alignment_minimal(alignment_payload, expected_ids)
    atomic_json(out_dir / "alignment.json", alignment_payload)

    rendered = build_rendered_page(
        plan,
        aligned,
        image_path=str(generated),
        image_width=image_width,
        image_height=image_height,
        image_provider="openai",
        image_model=args.image_model,
        planner_model=args.text_model,
        aligner_model=args.text_model,
    )
    atomic_json(out_dir / "rendered-page.json", rendered)
    resolver = check_center_resolver(rendered)

    result = {
        "b0_live_ok": True,
        "logical_calls": 3,
        "planner": {
            "provider": planner_envelope.get("provider"),
            "model": planner_envelope.get("model"),
            "page_plan_valid": True,
        },
        "image": {
            "provider": image_envelope.get("provider"),
            "model": image_envelope.get("model"),
            "requested_model": args.image_model,
            "path": str(generated),
            "bytes": generated.stat().st_size,
            "width": image_width,
            "height": image_height,
        },
        "aligner": {
            "provider": align_envelope.get("provider"),
            "model": align_envelope.get("model"),
            "bbox_validation": True,
            "hotspot_ids": expected_ids,
        },
        "rendered_page_validation": True,
        "resolver_check": resolver,
        "ledger": str(ledger_path),
    }
    atomic_json(out_dir / "B0_LIVE_RESULT.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OpenClawContractError as exc:
        print(f"B0_CONTRACT_FAILED={exc}", file=sys.stderr)
        raise SystemExit(1) from exc
