# OpenFlipbook NAS — Developer Handoff

Release: `nas-self-use-v1.0.2`
Next.js baseline: `15.5.24`

## Purpose

Private, single-owner NAS fork. Not the generic upstream BYO-key demo.

## Topology

| Service | Container | Host exposure | Persistence |
|---|---|---|---|
| Web | `openflipbook-web` | `0.0.0.0:3000` | stateless |
| Backend | `openflipbook-backend` | `127.0.0.1:8787` | stateless |
| Mongo | `openflipbook-mongo` | `127.0.0.1:27017` | `openflipbook-a0_mongo-data` |
| MinIO | `openflipbook-minio` | `127.0.0.1:9000/9001` | `openflipbook-a0_minio-data` |

Use `scripts/nas-compose.sh`. Never destroy data volumes for app updates.

## Provider invariants

- planner/alignment: `openai/gpt-5.6-luna`
- image: `openai/gpt-image-2`
- authenticated OpenClaw Gateway only
- no FAL/OpenRouter/direct-key fallback
- provider/model UI read-only
- no hidden retry/fallback

## Graph / hotspot invariants

Persist `session_id`, `parent_id`, `source_hotspot_id`, `click_in_parent`,
PagePlan, aligned hotspots, sources.

Planned semantic chain:
`id -> label -> sub_query -> visual_target -> desired_bbox`

Aligned geometry wins. Planned desired_bbox is fallback.
Direct DOM label activation preserves exact id/sub_query.

## Persistence invariant

Order:
1. final generation payload
2. persist node
3. receive saved id
4. update page/history/trail/route
5. ready
6. release generation

Do not reintroduce fire-and-forget first-child persistence.
NAS shared incoming/co-viewer UI stays hidden.

## Session semantics

- top query => fresh independent root/session
- New Session => empty session
- History => resume/delete
- NAS delete can remove exact visible History sessions across old owner-cookie mismatch
- non-NAS owner checks stay intact

## Branches / Related Topics

Branch beacons stay on-image; textual chooser is outside image.

`相關主題`:
1. request 3–5 text suggestions
2. persist/generate nothing yet
3. user selects
4. dispatch exactly one normal generation

Do not restore upstream multi-neighbor bloom in NAS.

## Image delivery

Browser uses same-origin `/api/image/<nodeId>` resolving `nodeId -> image_key`.
Do not expose arbitrary MinIO keys.

## Localization

Default `zh-TW`; UI and output locales are independent.

## Backup / restore

Offline book = reading artifact for one session.
Owner backup = all sessions/nodes/images + manifest + SHA coverage.
Restore = dry-run, explicit confirm, collision-safe remap, no overwrite.

## Health

- backend `/health`
- `/api/ready`
- `/api/status`
- `/status`

Readiness must not dispatch AI/search.

## Security baseline

`nas-self-use-v1.0.2` pins Next.js `15.5.24`, the August 2026 15.x
Maintenance-LTS security backport.

Routine security maintenance stays on Next 15 unless a separately reviewed
major-upgrade project is opened.

## OpenClaw native-hook OOM warning

Tool-heavy Agent work previously accumulated `openclaw-hooks` relays and could
exhaust NAS RAM.

Successful containment:
- `tools.loopDetection.enabled=false`
- stale relay >60s = 0
- Docker PID/memory protection
- serial/no-subagent work

For a future OpenClaw container recreate, evaluate/retain
`OPENCLAW_NO_RESPAWN=1` according to operator policy.

## Release gate

For Web security patches:
- audit before/after
- Web Vitest/typecheck/lint/build
- canonical Compose
- Web Docker build
- real persisted-data Chromium
- HF4 persistence/branch/related-topic regression
- Web rollback / roll-forward
- zero provider/model/SearXNG when generation is unnecessary

## Git / rollback safety

Do not use `git reset --hard`, `git clean`, or volume deletion as operational
rollback. Roll back stateless application images; keep Mongo/MinIO untouched.

## Intentional exclusions

World Mode, AI video, AI prefetch, alternate providers, public collaboration,
editable provider/model routing, upstream auto-merge.

## Future work

Open a maintenance round only for a concrete trigger:
security, targeted upstream correctness fix, OpenClaw compatibility,
dependency maintenance, or a real user bug.
