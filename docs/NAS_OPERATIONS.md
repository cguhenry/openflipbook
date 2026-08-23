# NAS self-use operations

The NAS profile is a private, single-owner product surface. Its only live AI
path is the authenticated OpenClaw Gateway:

- planner and alignment: `openai/gpt-5.6-luna`
- image generation: `openai/gpt-image-2`
- provider/model controls: read-only
- alternate provider fallback: none
- direct API-key billing: none

The Settings / Runtime drawer on `/play` shows this fixed routing, service
health, stage circuit breakers, operational counters, caps, and the backup
actions. It does not present legacy provider-dollar estimates as OAuth quota.

## Resilience and usage

OpenClaw has separate `responses` and `image` breakers. Three consecutive
transient failures open only the affected stage for 120 seconds. Network
errors, timeouts, HTTP 429, HTTP 5xx, and transient tool/media failures count.
Input/contract validation, cancellation, user 4xx responses, and usage-cap
rejections do not count. An open breaker returns `OPENCLAW_CIRCUIT_OPEN` before
dispatch; History, Resume, and Offline export remain available.

Usage counters are labeled `since backend start` and reset when the backend
restarts. They count generation outcomes and actual planner, alignment, image,
and SearXNG dispatches. Optional generation caps default to unlimited:

```dotenv
FLIPBOOK_MAX_RUNTIME_GENERATIONS=0
FLIPBOOK_MAX_SESSION_GENERATIONS=0
```

A positive cap rejects the next generation before any provider/search dispatch
with `OPENFLIPBOOK_USAGE_CAP_REACHED`. There is no retry or provider fallback.

## Export formats

The two ZIP formats have different purposes:

- **Offline book** exports one session as the existing portable viewer:
  `index.html`, `assets/`, `data/book.js`, and `images/`. It intentionally has
  no `manifest.json`.
- **Owner backup** exports every session owned by the current browser, its node
  graph, and required images. It uses `openflipbook.backup.v1` with a
  `manifest.json` containing the exact byte size and SHA-256 of every payload.

Owner backups contain only allowlisted graph fields. Cookies, authorization
headers, passwords, tokens, environment files, OpenClaw configuration, runtime
secrets, provider credentials, and storage-only prompt fields are excluded.

## Restore safety

Selecting an owner backup in Settings performs validation and a dry-run only.
The importer verifies ZIP structure/CRC, safe relative POSIX paths, unique
members, manifest coverage, sizes, hashes, graph lineage, and required images
before any mutation. Existing session and node IDs are never overwritten;
collisions are remapped consistently, including parent and scene references.
New image keys are create-only.

A real restore requires both `?confirm=true` and the explicit confirmation
header used by the UI. Images are uploaded serially, graph rows become visible
in one Mongo transaction, and uploaded images are deleted if the graph commit
fails. Restore and dry-run make zero provider/model/search calls.

## NAS compose defaults

The repo-tracked canonical runtime is the merged base plus NAS override under
Compose project `openflipbook-a0`. Always invoke it through the serial wrapper:

```bash
scripts/nas-compose.sh config --quiet
scripts/nas-compose.sh up -d
scripts/nas-compose.sh ps
```

The wrapper fixes both the project name and Compose files and exports
`COMPOSE_PARALLEL_LIMIT=1`. Web, backend, Mongo, and MinIO share only
`openflipbook-a0_default`; no workpack or Phase D overlay is required. Existing
data remains in the external volumes `openflipbook-a0_mongo-data` and
`openflipbook-a0_minio-data`.

Only Web port `3000` is intended for NAS clients. Backend `8787`, Mongo `27017`,
and MinIO `9000/9001` bind to `127.0.0.1`. Persisted legacy `image_url` values
remain backward-compatible, but normal Web, permalink, atlas, heatmap, and
postcard presentation reads images through `/api/image/<nodeId>` on the Web
origin; client devices never need their own `localhost:9000`.

`docker-compose.yml` keeps video and AI prefetch disabled, while enabling the
existing HTML5 View Transition and offline-export paths. System
`prefers-reduced-motion` is always honored; Settings can persist an additional
force-reduced preference. No AI animation or video is used by the NAS profile.

The NAS image defaults the interface to `zh-TW`. Interface language is stored
under `openflipbook.uiLocale`; generated-content language is stored separately
under `openflipbook.outputLocale`. Changing either setting does not change the
other.

## Readiness

`GET /api/ready` is the release and Docker health gate. It performs only three
bounded, read-only checks: backend `/health`, Mongo `ping`, and a MinIO bucket
HEAD. It does not contact OpenClaw, SearXNG, or a model provider. A healthy
response is:

```json
{"ok":true,"backend":true,"mongo":true,"minio":true}
```

Check both the product endpoint and container state after an operational
change:

```bash
curl -fsS http://127.0.0.1:3000/api/ready
COMPOSE_PARALLEL_LIMIT=1 docker compose ps
```

## Upgrade and restart

Before every upgrade, use **設定 / 執行狀態 → 下載完整備份** in the owner
browser, retain the ZIP outside the repository, and record its SHA-256 with
`sha256sum`. Verify the archive with the current backup tests or perform a
restore dry-run before changing services.

Keep the current Git commit and Web/backend image IDs as rollback references.
With a clean source tree, build and restart one application service at a time:

```bash
export COMPOSE_PARALLEL_LIMIT=1
scripts/nas-compose.sh build backend
scripts/nas-compose.sh up -d --no-deps backend
curl -fsS http://127.0.0.1:8787/health
scripts/nas-compose.sh build web
scripts/nas-compose.sh up -d --no-deps web
curl -fsS http://127.0.0.1:3000/api/ready
```

Do not restart Mongo or MinIO for an application-only upgrade. When a datastore
restart is explicitly required, restart exactly one container, wait for
`/api/ready` to recover, then proceed to the other. Never substitute volume or
bucket recreation for a failed restart.

## Rollback

Prefer redeploying the recorded previous Web/backend image IDs or rebuilding
the exact previous Git commit. Roll back the backend first, require `/health`,
then roll back Web and require `/api/ready`. Application rollback must leave
Mongo and MinIO data in place; it does not require restoring a backup unless a
separate, verified data migration changed persisted formats.

Never use `scripts/nas-compose.sh down -v`, delete Compose volumes, drop the Mongo
database or collections, or delete/recreate the MinIO bucket. Do not use a Git
hard reset as an operational rollback.

## Owner-backup recovery

Open **設定 / 執行狀態 → 還原完整備份** in the intended owner browser and
select the backup ZIP. Selection performs validation and a zero-mutation dry
run. Check session, page, image, provider-call, and collision-remap counts.
Only then use **確認還原**. After confirmation, require `/api/ready`, verify
History/Resume, open representative images, export an offline book, and create
a new backup. Keep the original archive and SHA-256 until all checks pass.
