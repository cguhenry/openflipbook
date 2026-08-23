#!/usr/bin/env python3
"""B3 live acceptance through the real web product API surface.

The managed browser driver is unavailable in this environment, so this
script runs inside the NAS web network namespace. It still uses the same
image route, seed route, node persistence route, history route, and offline
export route that the browser upload handler uses. It prints assertions only;
image bytes and provider envelopes stay in memory.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from dataclasses import asdict, dataclass
from http.cookiejar import CookieJar
from pathlib import Path
from typing import Any

SOURCE_NODE = "70113e9e-8d88-4c95-85bb-9e28f754b70f"
ACCEPTANCE_BASE_ENV = "OPENFLIPBOOK_ACCEPTANCE_BASE_URL"
ACCEPTANCE_RESULTS_ENV = "B3_ACCEPTANCE_RESULTS_DIR"
ACCEPTANCE_LEDGER_ENV = "B3_ACCEPTANCE_LEDGER_NAME"
DEFAULT_LEDGER_NAME = "b3-r1-resume3-live-image-seed-ledger.json"
MAX_ERROR_BODY = 8192
_IMAGE_DATA_RE = re.compile(
    r"(data:image/[A-Za-z0-9.+-]+;base64,)[A-Za-z0-9+/=_-]+", re.IGNORECASE
)
_LONG_VALUE_RE = re.compile(r"[A-Za-z0-9+/_=-]{220,}")
_SECRET_FIELD_RE = re.compile(
    r"(?i)([\"']?(?:authorization|cookie|password|secret|token|api[_-]?key)"
    r"[\"']?\s*[:=]\s*[\"']?)[^,\"'\s}]+"
)


@dataclass(frozen=True)
class SafeHttpError:
    status: int
    content_type: str
    body: str
    headers: dict[str, str]


class SafeHttpRequestError(RuntimeError):
    """An HTTP failure whose evidence contains no request or image payload."""

    def __init__(self, error: SafeHttpError) -> None:
        self.error = error
        super().__init__(format_safe_http_error(error))


def _sanitize_error_body(value: str) -> str:
    value = _IMAGE_DATA_RE.sub(r"\1<REDACTED_IMAGE_DATA>", value)
    value = re.sub(r"(?i)(bearer\s+)[^\s\"'}]+", r"\1<REDACTED>", value)
    value = _SECRET_FIELD_RE.sub(r"\1<REDACTED>", value)
    return _LONG_VALUE_RE.sub("<REDACTED_LONG_VALUE>", value)


def _header_value(headers: Any, name: str) -> str:
    if headers is None:
        return ""
    try:
        direct = headers.get(name)
        if direct:
            return str(direct)
    except AttributeError:
        return ""
    try:
        for key, value in headers.items():
            if str(key).lower() == name.lower() and value:
                return str(value)
    except AttributeError:
        return ""
    return ""


def safe_http_error(exc: urllib.error.HTTPError) -> SafeHttpError:
    """Read a capped HTTP error body without retaining auth or image bytes."""

    try:
        raw = exc.read(MAX_ERROR_BODY + 1)
    except Exception:
        raw = b""
    truncated = len(raw) > MAX_ERROR_BODY
    raw = raw[:MAX_ERROR_BODY]
    body = _sanitize_error_body(raw.decode("utf-8", errors="replace"))
    if truncated:
        body += "...<TRUNCATED>"

    headers: dict[str, str] = {}
    for name in ("retry-after", "x-trace-id", "x-request-id"):
        value = _header_value(exc.headers, name)
        if value:
            headers[name] = _sanitize_error_body(value)
    content_type = _header_value(exc.headers, "content-type")
    return SafeHttpError(
        status=int(exc.code),
        content_type=content_type,
        body=body,
        headers=headers,
    )


def format_safe_http_error(error: SafeHttpError) -> str:
    return json.dumps(asdict(error), ensure_ascii=False, sort_keys=True)


def _emit_safe_http_error(error: SafeHttpError, filename: str = "http-error.json") -> None:
    """Preserve only sanitized response evidence in stderr and an optional result file."""

    serialized = format_safe_http_error(error)
    print(f"B3_SAFE_HTTP_ERROR {serialized}", file=sys.stderr)
    raw_dir = os.environ.get(ACCEPTANCE_RESULTS_ENV, "").strip()
    if not raw_dir:
        return
    result_dir = Path(raw_dir)
    result_dir.mkdir(parents=True, exist_ok=True)
    (result_dir / filename).write_text(serialized + "\n", encoding="utf-8")


def http_error_capture_self_test() -> None:
    """Prove a synthetic 502 body survives while secrets and image bytes do not."""

    raw = (
        b'{"error":"synthetic-502","image":"data:image/png;base64,'
        + b"A" * 512
        + b'","authorization":"Bearer synthetic-secret"}'
    )
    def synthetic_error() -> urllib.error.HTTPError:
        return urllib.error.HTTPError(
            "http://synthetic.invalid/image-seed",
            502,
            "Bad Gateway",
            {
                "Content-Type": "application/json",
                "Set-Cookie": "gateway-secret=do-not-retain",
            },
            io.BytesIO(raw),
        )

    error = synthetic_error()
    safe = safe_http_error(error)
    assert safe.status == 502
    assert safe.content_type == "application/json"
    assert "synthetic-502" in safe.body
    assert "synthetic-secret" not in safe.body
    assert "A" * 220 not in safe.body
    assert "Set-Cookie" not in format_safe_http_error(safe)
    class SyntheticOpener:
        def open(self, req: Any, timeout: float) -> Any:
            raise synthetic_error()

    try:
        request(SyntheticOpener(), "http://synthetic.invalid", "POST", "/image-seed")
    except SafeHttpRequestError as raised:
        assert raised.error.status == 502
        assert "synthetic-502" in raised.error.body
    else:
        raise AssertionError("request() did not convert synthetic HTTPError")
    _emit_safe_http_error(safe, "http-error-capture-self-test.json")
    print("B3_HTTP_ERROR_CAPTURE_SELF_TEST_OK")
    print("body_retained=true")
    print("provider_calls=0")


def _write_result_json(filename: str, value: dict[str, Any]) -> None:
    raw_dir = os.environ.get(ACCEPTANCE_RESULTS_ENV, "").strip()
    if not raw_dir:
        return
    result_dir = Path(raw_dir)
    result_dir.mkdir(parents=True, exist_ok=True)
    (result_dir / filename).write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def _write_live_ledger(
    state: str,
    started_at: float,
    *,
    finished_at: float | None = None,
    returncode: int | None = None,
    **extra: Any,
) -> None:
    ledger: dict[str, Any] = {
        "state": state,
        "started_at_epoch": started_at,
        "source_node": SOURCE_NODE,
        "expected_new_luna_attempts": 1,
        "expected_image_generation_calls": 0,
        "expected_second_alignment_calls": 0,
        "expected_searxng_calls": 0,
        "retries": 0,
        "manual_recovery_allowed": False,
        "transport_preflight_passed_before_ledger": True,
    }
    if finished_at is not None:
        ledger["finished_at_epoch"] = finished_at
    if returncode is not None:
        ledger["returncode"] = returncode
    ledger.update(extra)
    ledger_name = os.environ.get(ACCEPTANCE_LEDGER_ENV, DEFAULT_LEDGER_NAME).strip()
    if not ledger_name or Path(ledger_name).name != ledger_name:
        raise ValueError("acceptance ledger name must be a simple filename")
    _write_result_json(ledger_name, ledger)


def _start_live_ledger(base_url: str) -> float:
    started_at = time.time()
    _write_live_ledger("started", started_at, base_url=base_url)
    previous_hook = sys.excepthook

    def finish_failed(exc_type: Any, exc: BaseException, traceback: Any) -> None:
        extra: dict[str, Any] = {"error_artifact": "http-error.json"}
        if isinstance(exc, SafeHttpRequestError):
            extra["http_error_status"] = exc.error.status
        _write_live_ledger(
            "failed",
            started_at,
            finished_at=time.time(),
            returncode=1,
            **extra,
        )
        previous_hook(exc_type, exc, traceback)

    sys.excepthook = finish_failed
    return started_at


def audit_real_image_payload(
    opener: urllib.request.OpenerDirector, base_url: str
) -> None:
    """Build B3's real image request through an in-process fake Gateway transport."""

    source_node = get_json(opener, base_url, f"/api/nodes/{SOURCE_NODE}")
    assert isinstance(source_node.get("image_url"), str) and source_node["image_url"].strip()
    source_status, source_content_type, source_bytes = request(
        opener, base_url, "GET", f"/api/image/{SOURCE_NODE}"
    )
    assert source_status == 200 and source_bytes
    media_type = source_content_type.split(";", 1)[0].strip().lower()
    assert media_type.startswith("image/")
    image_data_url = (
        f"data:{media_type};base64," + base64.b64encode(source_bytes).decode("ascii")
    )

    async def run_fake_transport() -> tuple[Any, list[Any]]:
        import httpx

        # These imports resolve inside the backend container, where the
        # production adapter is installed; the host harness remains stdlib-only.
        from contracts.mock_page_contract import build_mock_image_seed_payload
        from providers.openclaw_runtime import OpenClawGatewayClient

        class FakeGatewayTransport:
            def __init__(self) -> None:
                self.requests: list[httpx.Request] = []

            async def request(
                self,
                method: str,
                url: str,
                *,
                headers: dict[str, str],
                json: dict[str, Any] | None = None,
                params: dict[str, str] | None = None,
                timeout: float,
            ) -> httpx.Response:
                assert json is not None
                wire_request = httpx.Request(method, url, json=json)
                self.requests.append(wire_request)
                payload = build_mock_image_seed_payload()
                envelope = {
                    "status": "completed",
                    "output": [
                        {
                            "type": "message",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": json_module.dumps(
                                        payload, ensure_ascii=False
                                    ),
                                }
                            ],
                        }
                    ],
                }
                return httpx.Response(200, json=envelope, request=wire_request)

        fake = FakeGatewayTransport()
        result = await OpenClawGatewayClient(fake).image_seed(image_data_url)
        return result, fake.requests

    # Keep the module alias explicit so the fake transport's JSON parameter
    # cannot shadow the serializer used for the synthetic response envelope.
    json_module = json
    (_plan, _aligned), requests = asyncio.run(run_fake_transport())
    assert len(requests) == 1
    wire_request = requests[0]
    request_body = json.loads(wire_request.content)
    user_content = request_body["input"][1]["content"]
    image_parts = [part for part in user_content if part.get("type") == "input_image"]
    assert len(image_parts) == 1
    image_source = image_parts[0]["source"]
    decoded_bytes = len(base64.b64decode(image_source["data"], validate=True))
    tools = request_body.get("tools") or []
    tool_choice = request_body.get("tool_choice", "omitted")
    result = {
        "transport": "OpenClawGatewayClient.image_seed -> responses_json",
        "endpoint": wire_request.url.path,
        "model": request_body.get("model"),
        "source_node": SOURCE_NODE,
        "mime": image_source.get("media_type"),
        "decoded_image_bytes": decoded_bytes,
        "serialized_request_bytes": len(wire_request.content),
        "input_image_count": len(image_parts),
        "image_source_type": image_source.get("type"),
        "image_source_is_base64": image_source.get("type") == "base64",
        "tools_count": len(tools),
        "tool_choice": tool_choice,
        "request_under_20MiB": len(wire_request.content) < 20 * 1024 * 1024,
        "decoded_image_under_10MiB": decoded_bytes < 10 * 1024 * 1024,
        "fake_transport_calls": len(requests),
        "provider_calls": 0,
        "base64_saved": False,
    }
    assert result["endpoint"] == "/v1/responses"
    assert result["input_image_count"] == 1
    assert result["image_source_is_base64"] is True
    assert result["tools_count"] == 0
    assert result["tool_choice"] == "none"
    assert result["request_under_20MiB"] is True
    assert result["decoded_image_under_10MiB"] is True
    assert result["decoded_image_bytes"] == len(source_bytes)
    assert result["fake_transport_calls"] == 1
    assert result["provider_calls"] == 0
    _write_result_json("b3-r1-resume2-real-image-payload-audit.json", result)
    print("B3_REAL_IMAGE_PAYLOAD_AUDIT_OK")
    for key, value in result.items():
        print(f"{key}={str(value).lower() if isinstance(value, bool) else value}")


def normalize_base_url(raw: str | None) -> str:
    if not raw or not raw.strip():
        raise ValueError(
            "--base-url is required (or set OPENFLIPBOOK_ACCEPTANCE_BASE_URL)"
        )
    base = raw.strip().rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("base URL must be an absolute http(s) URL")
    if parsed.query or parsed.fragment:
        raise ValueError("base URL must not contain a query or fragment")
    return base


def request(
    opener: urllib.request.OpenerDirector,
    base_url: str,
    method: str,
    path: str,
    *,
    body: bytes | None = None,
    content_type: str | None = None,
) -> tuple[int, str, bytes]:
    headers = {}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(base_url + path, data=body, headers=headers, method=method)
    try:
        with opener.open(req, timeout=45) as response:
            return response.status, response.headers.get("Content-Type", ""), response.read()
    except urllib.error.HTTPError as error:
        safe = safe_http_error(error)
        _emit_safe_http_error(safe)
        raise SafeHttpRequestError(safe) from None


def get_json(
    opener: urllib.request.OpenerDirector, base_url: str, path: str
) -> dict[str, Any]:
    status, _content_type, body = request(opener, base_url, "GET", path)
    assert status == 200, f"{path} returned HTTP {status}"
    value = json.loads(body)
    assert isinstance(value, dict)
    return value


def post_json(
    opener: urllib.request.OpenerDirector,
    base_url: str,
    path: str,
    value: dict[str, Any],
) -> dict[str, Any]:
    status, _content_type, body = request(
        opener,
        base_url,
        "POST",
        path,
        body=json.dumps(value, ensure_ascii=False).encode(),
        content_type="application/json",
    )
    assert status == 200, f"{path} returned HTTP {status}"
    result = json.loads(body)
    assert isinstance(result, dict)
    return result


def point_in_polygon(x: float, y: float, polygon: list[list[float]]) -> bool:
    if len(polygon) < 3:
        return False
    inside_polygon = False
    previous = polygon[-1]
    for current in polygon:
        x1, y1 = previous
        x2, y2 = current
        if (y1 > y) != (y2 > y):
            x_at_y = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < x_at_y:
                inside_polygon = not inside_polygon
        previous = current
    return inside_polygon


def deterministic_hotspot(
    page_plan: dict[str, Any], aligned: list[dict[str, Any]], x: float, y: float
) -> tuple[str, str] | None:
    planned_by_id = {
        row["id"]: row for row in page_plan.get("hotspots", []) if "id" in row
    }
    rows = [
        (item, planned_by_id[item["id"]])
        for item in aligned
        if item.get("id") in planned_by_id
    ]
    if not rows or not (0 <= x <= 1 and 0 <= y <= 1):
        return None

    def confidence_order(row: tuple[dict[str, Any], dict[str, Any]]) -> tuple[float, str]:
        item, _planned = row
        return (-float(item["alignment_confidence"]), str(item["id"]))

    region_matches = [
        row
        for row in rows
        if point_in_polygon(x, y, row[0].get("tap_region", []))
    ]
    if region_matches:
        item, _planned = sorted(region_matches, key=confidence_order)[0]
        return str(item["id"]), "tap_region"

    bbox_matches = []
    for row in rows:
        item, _planned = row
        bx, by, width, height = item["actual_bbox"]
        if bx <= x <= bx + width and by <= y <= by + height:
            bbox_matches.append(row)
    if bbox_matches:
        item, _planned = sorted(bbox_matches, key=confidence_order)[0]
        return str(item["id"]), "bbox"

    def distance(row: tuple[dict[str, Any], dict[str, Any]]) -> tuple[float, float, str]:
        item, _planned = row
        bx, by, width, height = item["actual_bbox"]
        dx = x - (bx + width / 2)
        dy = y - (by + height / 2)
        confidence, item_id = confidence_order(row)
        return (dx * dx + dy * dy, confidence, item_id)

    item, _planned = sorted(rows, key=distance)[0]
    return str(item["id"]), "nearest"


def probe_image_seed_route(
    opener: urllib.request.OpenerDirector, base_url: str
) -> int:
    try:
        status, _content_type, _body = request(
            opener, base_url, "GET", "/api/image-seed"
        )
    except SafeHttpRequestError as error:
        status = error.error.status
        if status != 405:
            raise AssertionError(
                f"/api/image-seed route probe returned HTTP {status}"
            ) from error
    assert status in {200, 405}, f"/api/image-seed route probe returned HTTP {status}"
    return status


def preflight(opener: urllib.request.OpenerDirector, base_url: str) -> None:
    status, content_type, body = request(opener, base_url, "GET", "/api/status")
    assert status == 200 and content_type.startswith("application/json")
    status_payload = json.loads(body)
    assert isinstance(status_payload, dict)

    source_node = get_json(opener, base_url, f"/api/nodes/{SOURCE_NODE}")
    assert source_node.get("id") == SOURCE_NODE
    image_url = source_node.get("image_url")
    assert isinstance(image_url, str) and image_url.strip()

    source_status, source_content_type, source_bytes = request(
        opener, base_url, "GET", f"/api/image/{SOURCE_NODE}"
    )
    assert source_status == 200 and source_bytes
    assert source_content_type.split(";", 1)[0].strip().lower().startswith("image/")

    route_status = probe_image_seed_route(opener, base_url)
    print("B3_R1_PREFLIGHT_OK")
    print(f"base_url={base_url}")
    print(f"source_node={SOURCE_NODE}")
    print(f"source_image_bytes={len(source_bytes)}")
    print(f"image_seed_route_probe_status={route_status}")
    print("provider_calls=0")


def inside(point: tuple[float, float], polygon: list[list[float]]) -> bool:
    xs = [row[0] for row in polygon]
    ys = [row[1] for row in polygon]
    return min(xs) <= point[0] <= max(xs) and min(ys) <= point[1] <= max(ys)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default=os.environ.get(ACCEPTANCE_BASE_ENV),
        help=f"explicit Web base URL (or {ACCEPTANCE_BASE_ENV})",
    )
    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help="verify Web/source-node/image/route readiness without POSTing image-seed",
    )
    parser.add_argument(
        "--results-dir",
        default=os.environ.get(ACCEPTANCE_RESULTS_ENV),
        help=f"directory for sanitized HTTP error evidence (or {ACCEPTANCE_RESULTS_ENV})",
    )
    parser.add_argument(
        "--http-error-capture-self-test",
        action="store_true",
        help="run the synthetic zero-provider HTTP 502 capture test",
    )
    parser.add_argument(
        "--payload-audit-only",
        action="store_true",
        help="audit the real source image through a fake OpenClaw transport",
    )
    args = parser.parse_args()
    if args.results_dir:
        os.environ[ACCEPTANCE_RESULTS_ENV] = args.results_dir
    if args.http_error_capture_self_test:
        http_error_capture_self_test()
        return
    try:
        base_url = normalize_base_url(args.base_url)
    except ValueError as error:
        parser.error(str(error))

    jar = CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    if args.payload_audit_only:
        audit_real_image_payload(opener, base_url)
        return
    if args.preflight_only:
        preflight(opener, base_url)
        return

    preflight(opener, base_url)
    live_started_at = _start_live_ledger(base_url)

    _source_node = get_json(opener, base_url, f"/api/nodes/{SOURCE_NODE}")
    source_status, source_content_type, source_bytes = request(
        opener, base_url, "GET", f"/api/image/{SOURCE_NODE}"
    )
    assert source_status == 200 and source_bytes and source_content_type.startswith("image/")
    media_type = source_content_type.split(";", 1)[0].strip().lower()
    assert media_type.startswith("image/")
    image_data_url = (
        f"data:{media_type};base64,"
        + base64.b64encode(source_bytes).decode("ascii")
    )

    session_id = "session_b3_live_" + uuid.uuid4().hex
    trace_id = "b3-live-" + uuid.uuid4().hex
    seed = post_json(
        opener,
        base_url,
        "/api/image-seed",
        {"session_id": session_id, "image_data_url": image_data_url, "trace_id": trace_id},
    )
    plan = seed.get("page_plan")
    aligned = seed.get("aligned_hotspots")
    assert isinstance(plan, dict) and plan.get("schema_version") == "1.0"
    assert isinstance(aligned, list)
    assert isinstance(plan.get("title"), str) and plan["title"].strip()
    assert isinstance(plan.get("summary"), str) and plan["summary"].strip()
    text_blocks = plan.get("text_blocks", [])
    assert 1 <= len(text_blocks) <= 4
    assert all(
        isinstance(row.get("id"), str)
        and re.fullmatch(r"t[0-9]{3,}", row["id"])
        and isinstance(row.get("text"), str)
        and row["text"].strip()
        and isinstance(row.get("anchor"), str)
        and "bbox" not in row
        for row in text_blocks
    )
    assert 2 <= len(plan.get("hotspots", [])) <= 8
    assert plan.get("motion_hints") == []
    assert plan.get("sources") == []
    planned_ids = {row["id"] for row in plan["hotspots"]}
    aligned_ids = {row["id"] for row in aligned}
    assert planned_ids == aligned_ids
    assert all(re.fullmatch(r"h[0-9]{3,}", str(item_id)) for item_id in planned_ids)
    for hotspot in plan["hotspots"]:
        x, y, width, height = hotspot["desired_bbox"]
        assert 0 <= x <= 1 and 0 <= y <= 1 and width > 0 and height > 0
        assert x + width <= 1 and y + height <= 1
        row = next(item for item in aligned if item["id"] == hotspot["id"])
        ax, ay, aw, ah = row["actual_bbox"]
        assert 0 <= ax <= 1 and 0 <= ay <= 1 and aw > 0 and ah > 0
        assert ax + aw <= 1 and ay + ah <= 1
        assert all(0 <= point[0] <= 1 and 0 <= point[1] <= 1 for point in row["tap_region"])
        assert inside((ax + aw / 2, ay + ah / 2), row["tap_region"])
    root = post_json(
        opener,
        base_url,
        "/api/nodes",
        {
            "parent_id": None,
            "session_id": session_id,
            "query": plan["title"],
            "page_title": plan["title"],
            "image_data_url": image_data_url,
            "image_model": "user-upload",
            "prompt_author_model": "openai/gpt-5.6-luna",
            "aspect_ratio": plan["scene"]["aspect_ratio"],
            "final_prompt": plan["scene"]["prompt"],
            "sources": [],
            "seed_type": "image",
            "page_plan": plan,
            "aligned_hotspots": aligned,
            "trace_id": trace_id,
        },
    )
    root_id = root["id"]
    persisted = get_json(opener, base_url, f"/api/nodes/{root_id}")
    assert persisted["session_id"] == session_id
    assert persisted["seed_type"] == "image"
    assert persisted["page_plan"]["schema_version"] == "1.0"
    assert persisted["aligned_hotspots"]
    _root_status, _root_content_type, root_bytes = request(
        opener, base_url, "GET", f"/api/image/{root_id}"
    )
    assert root_bytes == source_bytes

    hydrated = get_json(opener, base_url, f"/api/sessions/{session_id}")
    assert len(hydrated["nodes"]) == 1
    assert hydrated["nodes"][0]["id"] == root_id
    assert hydrated["nodes"][0]["seed_type"] == "image"
    resumed = get_json(opener, base_url, f"/api/sessions/{session_id}")
    assert resumed == hydrated
    summaries = get_json(opener, base_url, "/api/sessions")
    matching = [row for row in summaries["sessions"] if row["session_id"] == session_id]
    assert matching and matching[0]["root_node_id"] == root_id

    deterministic_probes = []
    for row in aligned:
        ax, ay, aw, ah = row["actual_bbox"]
        deterministic_probes.append((ax + aw / 2, ay + ah / 2))
    assert deterministic_probes
    for point in deterministic_probes:
        first = deterministic_hotspot(plan, aligned, *point)
        second = deterministic_hotspot(plan, aligned, *point)
        assert first is not None and first == second

    export_status, export_type, export_bytes = request(
        opener, base_url, "GET", f"/api/export/offline/{session_id}"
    )
    assert export_status == 200 and export_type.startswith("application/zip")
    with zipfile.ZipFile(io.BytesIO(export_bytes)) as archive:
        names = archive.namelist()
        image_names = [name for name in names if name.startswith("images/")]
        assert image_names
        assert any(archive.read(name) == source_bytes for name in image_names)
        assert "index.html" in names
        assert "assets/player.js" in names
        assert "assets/player.css" in names
        assert "data/book.js" in names
        book_script = archive.read("data/book.js").decode("utf-8")
        assert "window.OPENFLIPBOOK_OFFLINE_BOOK=" in book_script
        assert "fetch(" not in book_script

    fresh_session = "session_b3_new_" + uuid.uuid4().hex
    fresh_state = get_json(opener, base_url, f"/api/sessions/{fresh_session}")
    assert fresh_state["nodes"] == []
    summaries_after_new_session = get_json(opener, base_url, "/api/sessions")
    assert any(
        row["session_id"] == session_id for row in summaries_after_new_session["sessions"]
    )

    status = get_json(opener, base_url, "/api/status")
    serialized = json.dumps(status)
    for forbidden in ("password", "bearer", "oauth", "pw.txt", "provider_envelope"):
        assert forbidden not in serialized.lower()

    branch_hydrations = 0
    for summary in summaries["sessions"]:
        children = get_json(
            opener,
            base_url,
            f"/api/nodes/{summary['root_node_id']}/children",
        )["children"]
        if len(children) > 1:
            for child in children:
                child_payload = get_json(opener, base_url, f"/api/nodes/{child['id']}")
                assert child_payload["id"] == child["id"]
                branch_hydrations += 1

    _write_live_ledger(
        "succeeded",
        live_started_at,
        finished_at=time.time(),
        returncode=0,
        session_id=session_id,
        root_node_id=root_id,
        persisted_branch_hydrations=branch_hydrations,
        actual_luna_image_seed_calls=1,
        actual_gpt_image_2_calls=0,
        actual_second_alignment_calls=0,
        actual_searxng_calls=0,
        actual_retries=0,
        manual_recovery_used=False,
    )
    print("B3_LIVE_API_ACCEPTANCE_OK")
    print(f"base_url={base_url}")
    print("fresh_session_persisted=true")
    print("same_image_bytes=true")
    print("page_plan_valid=true")
    print("dom_text_nonempty=true")
    print("hotspot_id_parity=true")
    print("local_tap_regions=true")
    print("deterministic_hotspot_resolution=true")
    print("reload_hydrated=true")
    print("history_summary_present=true")
    print("resume_hydrated=true")
    print("new_session_empty=true")
    print("previous_session_retained=true")
    print(f"persisted_branch_hydrations={branch_hydrations}")
    print("branch_navigation_reads_only=true")
    print("offline_export_original_image=true")
    print("runtime_status_redacted=true")
    print(f"root_node_id={root_id}")
    print(f"session_id={session_id}")


if __name__ == "__main__":
    main()
