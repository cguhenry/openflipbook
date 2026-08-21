#!/usr/bin/env python3
from __future__ import annotations

import json
import struct
import sys
import zlib
from pathlib import Path

args = sys.argv[1:]
joined = " ".join(args)

plan = {
    "schema_version": "1.0",
    "title": "蒸汽機如何運作",
    "summary": "fixture",
    "scene": {
        "prompt": "Educational steam engine cutaway, no text, no labels",
        "style": "textbook",
        "aspect_ratio": "16:9",
    },
    "text_blocks": [
        {"id": "t001", "role": "title", "text": "蒸汽機如何運作", "anchor": "top-left"},
        {"id": "t002", "role": "body", "text": "蒸汽推動活塞。", "anchor": "bottom-left"},
    ],
    "hotspots": [
        {
            "id": "h001",
            "label": "鍋爐",
            "sub_query": "鍋爐構造",
            "visual_target": "boiler",
            "desired_bbox": [0.05, 0.2, 0.25, 0.5],
        },
        {
            "id": "h002",
            "label": "汽缸",
            "sub_query": "汽缸結構",
            "visual_target": "cylinder",
            "desired_bbox": [0.35, 0.2, 0.25, 0.5],
        },
        {
            "id": "h003",
            "label": "飛輪",
            "sub_query": "飛輪結構",
            "visual_target": "flywheel",
            "desired_bbox": [0.68, 0.2, 0.25, 0.5],
        },
    ],
    "motion_hints": [],
    "sources": [],
}


def _png_1x1() -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    pixels = zlib.compress(b"\x00\x00\x00\x00\xff")
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")


if "infer image generate" in joined:
    output = Path(args[args.index("--output") + 1]) if "--output" in args else Path("/tmp/fake-b0.png")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(_png_1x1())
    print(
        json.dumps(
            {
                "ok": True,
                "capability": "image.generate",
                "transport": "local",
                "provider": "openai",
                "model": "gpt-image-2",
                "attempts": [],
                "outputs": [{"path": str(output), "mimeType": "image/png", "size": output.stat().st_size}],
            }
        )
    )
elif "infer model run" in joined and "--file" in args:
    alignment = {
        "hotspots": [
            {"id": "h001", "bbox": [0.06, 0.22, 0.24, 0.46], "confidence": 0.92},
            {"id": "h002", "bbox": [0.36, 0.23, 0.24, 0.44], "confidence": 0.90},
            {"id": "h003", "bbox": [0.69, 0.21, 0.23, 0.48], "confidence": 0.94},
        ]
    }
    print(
        json.dumps(
            {
                "ok": True,
                "capability": "model.run",
                "transport": "local",
                "provider": "openai",
                "model": "gpt-5.4-mini",
                "attempts": [],
                "outputs": [{"text": json.dumps(alignment, ensure_ascii=False)}],
            },
            ensure_ascii=False,
        )
    )
elif "infer model run" in joined:
    print(
        json.dumps(
            {
                "ok": True,
                "capability": "model.run",
                "transport": "local",
                "provider": "openai",
                "model": "gpt-5.4-mini",
                "attempts": [],
                "outputs": [{"text": json.dumps(plan, ensure_ascii=False)}],
            },
            ensure_ascii=False,
        )
    )
else:
    print(json.dumps({"ok": True, "outputs": []}))
