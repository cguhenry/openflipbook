#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d /tmp/openflipbook-b0-fake.XXXXXX)"
trap 'rm -rf -- "$tmp"' EXIT

mkdir -p "$tmp/bin"
cp "$repo/scripts/b0_fake_openclaw.py" "$tmp/bin/openclaw"
chmod +x "$tmp/bin/openclaw"

PATH="$tmp/bin:$PATH" python3 "$repo/scripts/b0_openclaw_live_probe.py" \
  --results-dir "$tmp/results" \
  --dry-run >"$tmp/dry.txt"
grep -q 'B0_DRY_RUN_CALL_BUDGET=3' "$tmp/dry.txt"
grep -q 'B0_DRY_RUN_NO_LIVE_CALLS=true' "$tmp/dry.txt"
if grep -q -- '--probe' "$tmp/dry.txt"; then
  echo "unexpected probe command" >&2
  exit 2
fi

PATH="$tmp/bin:$PATH" python3 "$repo/scripts/b0_openclaw_live_probe.py" \
  --results-dir "$tmp/results-live" \
  --execute-live >"$tmp/live.txt"

python3 - "$tmp/results-live" <<'PY'
import json
import pathlib
import sys

directory = pathlib.Path(sys.argv[1])
result = json.loads((directory / "B0_LIVE_RESULT.json").read_text())
assert result["b0_live_ok"] is True
assert result["logical_calls"] == 3
assert result["image"]["width"] == 1
assert result["image"]["height"] == 1
assert result["rendered_page_validation"] is True
assert result["resolver_check"]["ok"] is True
ledger = json.loads((directory / "call-ledger.json").read_text())
assert [ledger["stages"][name]["state"] for name in ("planner", "image", "aligner")] == [
    "completed",
    "completed",
    "completed",
]
PY

if PATH="$tmp/bin:$PATH" python3 "$repo/scripts/b0_openclaw_live_probe.py" \
  --results-dir "$tmp/results-live" --execute-live >/dev/null 2>&1; then
  echo "expected re-run refusal" >&2
  exit 3
fi

echo "B0_FAKE_PROBE_OK"
