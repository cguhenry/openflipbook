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

`docker-compose.yml` keeps video and AI prefetch disabled, while enabling the
existing HTML5 View Transition and offline-export paths. System
`prefers-reduced-motion` is always honored; Settings can persist an additional
force-reduced preference. No AI animation or video is used by the NAS profile.
