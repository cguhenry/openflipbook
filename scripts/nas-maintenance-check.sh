#!/usr/bin/env bash
set -euo pipefail

# Read-only NAS operator check. It never starts, stops, restarts, generates,
# fetches, mutates Git, or calls a product provider.
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
export COMPOSE_PARALLEL_LIMIT=1
web_url=${NAS_MAINTENANCE_WEB_URL:-http://127.0.0.1:3000}
session_id=${NAS_MAINTENANCE_SESSION_ID:-session_b3_live_8ce2bf1163044e9f92c878345dbbfec6}
json_path=
backup_path=
run_upstream=0

usage() {
  cat <<'EOF'
Usage: scripts/nas-maintenance-check.sh [--json PATH] [--backup ZIP] [--upstream]

Read-only, zero-provider checks for the canonical private NAS stack.
EOF
}

while (($#)); do
  case "$1" in
    --json)
      (($# >= 2)) || { echo "--json requires a path" >&2; exit 2; }
      json_path=$2
      shift 2
      ;;
    --backup)
      (($# >= 2)) || { echo "--backup requires a ZIP path" >&2; exit 2; }
      backup_path=$2
      shift 2
      ;;
    --upstream)
      run_upstream=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
checks_file=$tmp_dir/checks.tsv
: > "$checks_file"
failures=0

record() {
  name=$1
  status=$2
  detail=$3
  detail=$(printf '%s' "$detail" | tr '\n' ' ')
  printf '%s\t%s\t%s\n' "$name" "$status" "$detail" >> "$checks_file"
  [[ "$status" == PASS ]] || failures=$((failures + 1))
}

line_count() {
  value=$1
  if [[ -z "$value" ]]; then
    printf '0'
  else
    printf '%s\n' "$value" | wc -l | tr -d ' '
  fi
}

branch=$(git -C "$repo_dir" branch --show-current 2>/dev/null || true)
head=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || true)
origin_head=$(git -C "$repo_dir" rev-parse origin/main 2>/dev/null || true)
dirty=$(git -C "$repo_dir" status --porcelain 2>/dev/null || true)
staged=$(git -C "$repo_dir" diff --cached --name-only 2>/dev/null || true)
[[ "$branch" == main ]] && record git.branch PASS main || record git.branch FAIL "expected main"
[[ -n "$head" && "$head" == "$origin_head" ]] && record git.origin_relation PASS "HEAD equals origin/main" || record git.origin_relation FAIL "HEAD and origin/main differ"
[[ -z "$dirty" ]] && record git.worktree PASS clean || record git.worktree FAIL "dirty_paths=$(line_count "$dirty")"
[[ -z "$staged" ]] && record git.staging PASS "staged_paths=0" || record git.staging FAIL "staged_paths=$(line_count "$staged")"

compose_json=$tmp_dir/compose.json
if "$repo_dir/scripts/nas-compose.sh" config --format json > "$compose_json" 2> "$tmp_dir/compose.err"; then
  if compose_detail=$(python3 - "$compose_json" <<'PY'
import json, sys

doc = json.load(open(sys.argv[1], encoding="utf-8"))
services = doc.get("services", {})
volumes = doc.get("volumes", {})

def port_matches(service, target, published, host_ip=None):
    for port in services.get(service, {}).get("ports", []) or []:
        if not isinstance(port, dict):
            continue
        try:
            published_value = int(port.get("published", -1))
        except (TypeError, ValueError):
            published_value = -1
        if port.get("target") != target or published_value != published:
            continue
        if host_ip is None or port.get("host_ip") == host_ip:
            return True
    return False

def env(service):
    value = services.get(service, {}).get("environment", {}) or {}
    return value if isinstance(value, dict) else {}

def args(service):
    value = services.get(service, {}).get("build", {}) or {}
    value = value.get("args", {}) if isinstance(value, dict) else {}
    return value if isinstance(value, dict) else {}

def disabled(value):
    return str(value).strip().lower() in {"0", "false", "off", "no", ""}

web_env = env("web")
web_args = args("web")
backend_env = env("backend")
required_services = {"mongo", "minio", "backend", "web"}.issubset(services)
required_volumes = all(
    volumes.get(key, {}).get("name") == value and volumes.get(key, {}).get("external") is True
    for key, value in (
        ("mongo-data", "openflipbook-a0_mongo-data"),
        ("minio-data", "openflipbook-a0_minio-data"),
    )
)
ports = all([
    port_matches("web", 3000, 3000),
    port_matches("backend", 8787, 8787, "127.0.0.1"),
    port_matches("mongo", 27017, 27017, "127.0.0.1"),
    port_matches("minio", 9000, 9000, "127.0.0.1"),
    port_matches("minio", 9001, 9001, "127.0.0.1"),
])
locale = web_env.get("NEXT_PUBLIC_DEFAULT_UI_LOCALE") == "zh-TW"
flags = all([
    disabled(web_env.get("NEXT_PUBLIC_WORLD_MODE")),
    disabled(web_env.get("NEXT_PUBLIC_VIDEO")),
    disabled(web_env.get("NEXT_PUBLIC_AI_PREFETCH")),
    disabled(web_args.get("NEXT_PUBLIC_WORLD_MODE")),
    disabled(web_args.get("NEXT_PUBLIC_VIDEO")),
    disabled(web_args.get("NEXT_PUBLIC_AI_PREFETCH")),
    str(backend_env.get("WORLD_MODE", "")).strip().lower() in {"false", "0", "off"},
])
project = doc.get("name")
ok = project == "openflipbook-a0" and required_services and required_volumes and ports and locale and flags
print(json.dumps({
    "ok": ok,
    "project": project,
    "services": required_services,
    "volumes": required_volumes,
    "ports": ports,
    "zh_tw": locale,
    "disabled_features": flags,
}, separators=(",", ":")))
raise SystemExit(0 if ok else 1)
PY
); then
    record compose.canonical PASS "$compose_detail"
  else
    record compose.canonical FAIL "canonical NAS Compose expectations failed"
  fi
else
  record compose.canonical FAIL "docker compose config failed"
fi

for container in openflipbook-backend openflipbook-web openflipbook-mongo openflipbook-minio; do
  state_json=$(docker inspect --format '{{json .State}}' "$container" 2>/dev/null || true)
  if [[ -z "$state_json" ]]; then
    record "container.$container" FAIL "container missing"
    continue
  fi
  if container_detail=$(python3 - "$state_json" <<'PY'
import json, sys
state = json.loads(sys.argv[1])
status = state.get("Status")
health = state.get("Health")
health_status = health.get("Status") if isinstance(health, dict) else None
ok = status == "running" and (health_status is None or health_status == "healthy")
print(f"status={status} health={health_status or 'not_configured'}")
raise SystemExit(0 if ok else 1)
PY
); then
    record "container.$container" PASS "$container_detail"
  else
    record "container.$container" FAIL "not running or unhealthy"
  fi
done

http_get() {
  path=$1
  output=$2
  if curl --fail --silent --show-error --max-time 12 "$web_url$path" > "$output" 2> "$tmp_dir/http.err"; then
    return 0
  fi
  if docker inspect openflipbook-web >/dev/null 2>&1; then
    docker exec openflipbook-web wget -qO- "http://127.0.0.1:3000$path" > "$output" 2> "$tmp_dir/container-http.err"
    return $?
  fi
  return 1
}

ready_json=$tmp_dir/ready.json
if http_get /api/ready "$ready_json" && python3 - "$ready_json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
expected = {"ok": True, "backend": True, "mongo": True, "minio": True}
raise SystemExit(0 if value == expected else 1)
PY
then
  record http.ready PASS "backend/mongo/minio ready"
else
  record http.ready FAIL "GET /api/ready failed"
fi

status_json=$tmp_dir/status.json
if http_get /api/status "$status_json" && status_detail=$(python3 - "$status_json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
counters = (value.get("usage") or {}).get("counters") or {}
required = {
    "generation_requests", "generation_success", "generation_failed",
    "generation_cancelled", "planner_calls", "alignment_calls", "image_calls",
    "searxng_searches",
}
ok = (
    value.get("ok") is True
    and value.get("provider_control") == "read_only"
    and value.get("model_control") == "read_only"
    and required.issubset(counters)
    and all(isinstance(counters[key], int) and counters[key] >= 0 for key in required)
)
detail = "counters=" + ",".join(f"{key}:{counters[key]}" for key in sorted(required))
print(detail)
raise SystemExit(0 if ok else 1)
PY
); then
  record http.status PASS "$status_detail"
else
  record http.status FAIL "GET /api/status failed or unsafe status shape"
fi

session_json=$tmp_dir/session.json
session_path=/api/sessions/$session_id
if http_get "$session_path" "$session_json" && session_detail=$(python3 - "$session_json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
nodes = value.get("nodes") or []
ids = [node.get("id") for node in nodes]
ok = len(nodes) == 4 and all(isinstance(node_id, str) and node_id for node_id in ids)
print(f"session_nodes={len(nodes)}")
raise SystemExit(0 if ok else 1)
PY
); then
  record persistence.b4 PASS "$session_detail"
else
  record persistence.b4 FAIL "representative session unreadable or not four nodes"
fi

if [[ -s "$session_json" ]]; then
  node_id=$(python3 - "$session_json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
nodes = value.get("nodes") or []
print(nodes[0].get("id", "") if nodes else "")
PY
)
else
  node_id=
fi
image_file=$tmp_dir/image.bin
if [[ -n "$node_id" ]] && http_get "/api/image/$node_id" "$image_file" && [[ -s "$image_file" ]]; then
  record http.same_origin_image PASS "node=$node_id"
else
  record http.same_origin_image FAIL "representative same-origin image unavailable"
fi

if [[ -n "$backup_path" ]]; then
  dry_run=$tmp_dir/backup-dry-run.json
  backup_ok=0
  if [[ -f "$backup_path" ]]; then
    if curl --fail --silent --show-error --max-time 60 -X POST -H 'Content-Type: application/zip' --data-binary "@$backup_path" "$web_url/api/backup/owner/restore" > "$dry_run" 2> "$tmp_dir/backup.err"; then
      backup_ok=1
    elif docker inspect openflipbook-backend >/dev/null 2>&1 && docker exec -i openflipbook-backend sh -c 'curl --fail --silent --show-error -X POST -H "Content-Type: application/zip" --data-binary @- http://openflipbook-web:3000/api/backup/owner/restore' < "$backup_path" > "$dry_run" 2> "$tmp_dir/backup-container.err"; then
      backup_ok=1
    fi
  fi
  if [[ "$backup_ok" == 1 ]] && backup_detail=$(python3 - "$dry_run" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
ok = value.get("ok") is True and value.get("dry_run") is True and value.get("provider_calls") == 0
print(f"sessions={value.get('sessions', 0)} nodes={value.get('nodes', 0)} images={value.get('images', 0)}")
raise SystemExit(0 if ok else 1)
PY
); then
    record backup.restore_dry_run PASS "$backup_detail"
  else
    record backup.restore_dry_run FAIL "backup validation/dry-run failed"
  fi
fi

if [[ "$run_upstream" == 1 ]]; then
  upstream_url=$(git -C "$repo_dir" remote get-url upstream 2>/dev/null || true)
  if [[ "$upstream_url" != https://github.com/eren23/openflipbook.git ]]; then
    record upstream.remote FAIL "canonical upstream remote missing or wrong"
  elif ! git -C "$repo_dir" show-ref --verify --quiet refs/remotes/upstream/main; then
    record upstream.audit FAIL "upstream/main is absent; fetch it outside this read-only check"
  else
    upstream_head=$(git -C "$repo_dir" rev-parse refs/remotes/upstream/main)
    merge_base=$(git -C "$repo_dir" merge-base HEAD refs/remotes/upstream/main)
    counts=$(git -C "$repo_dir" rev-list --left-right --count HEAD...refs/remotes/upstream/main)
    changed=$(git -C "$repo_dir" diff --name-only "$merge_base..refs/remotes/upstream/main")
    record upstream.remote PASS "canonical URL"
    record upstream.audit PASS "head=$upstream_head merge_base=$merge_base ahead_behind=$counts changed_files=$(line_count "$changed")"
  fi
fi

if [[ -n "$json_path" ]]; then
  mkdir -p "$(dirname "$json_path")"
  python3 - "$checks_file" "$json_path" <<'PY'
import json, sys
checks = []
for line in open(sys.argv[1], encoding="utf-8"):
    name, status, detail = line.rstrip("\n").split("\t", 2)
    checks.append({"name": name, "status": status, "detail": detail})
payload = {
    "schema": "openflipbook.nas-maintenance-check.v1",
    "pass": all(item["status"] == "PASS" for item in checks),
    "checks": checks,
}
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
fi

if [[ "$failures" == 0 ]]; then
  echo NAS_MAINTENANCE_CHECK_PASS
else
  echo "NAS_MAINTENANCE_CHECK_FAIL failures=$failures"
fi
while IFS=$'\t' read -r name status detail; do
  printf '%s: %s (%s)\n' "$name" "$status" "$detail"
done < "$checks_file"
if [[ "$failures" == 0 ]]; then
  exit 0
fi
exit 1
