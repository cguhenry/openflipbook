# OpenFlipbook private NAS final handoff

This is the accepted private, single-owner NAS release on `main`. The exact
accepted Git SHA is the `final_head` recorded in the Phase E
`E_FINAL_REPORT.md`; on a deployed checkout, confirm it with `git rev-parse
HEAD` and require it to equal `origin/main`.

## Canonical runtime

Run every Compose operation from the repository root through:

```bash
scripts/nas-compose.sh config --quiet
scripts/nas-compose.sh up -d
scripts/nas-compose.sh ps
```

The wrapper fixes project `openflipbook-a0`, merges `docker-compose.yml` with
`docker-compose.nas.yml`, and enforces `COMPOSE_PARALLEL_LIMIT=1`.

| Service | Container | Network | Host exposure | Persistent data |
| --- | --- | --- | --- | --- |
| Web | `openflipbook-web` | `openflipbook-a0_default` | `0.0.0.0:3000` (LAN/client port) | none |
| Backend | `openflipbook-backend` | `openflipbook-a0_default` | `127.0.0.1:8787` | none |
| Mongo | `openflipbook-mongo` | `openflipbook-a0_default` | `127.0.0.1:27017` | `openflipbook-a0_mongo-data` |
| MinIO | `openflipbook-minio` | `openflipbook-a0_default` | `127.0.0.1:9000/9001` | `openflipbook-a0_minio-data` |

`mongo-init` and `minio-setup` are idempotent one-shot services in the same
project. There is no Phase D workpack-network dependency. Do not replace,
delete, or recreate either external volume or the MinIO bucket.

Web `:3000` is the only expected LAN-facing port. Caddy, Tailscale, router
forwarding, certificates, and public Internet exposure are separate operator
concerns and were not changed by this release.

## Fixed provider and product behavior

The only live AI route is backend → authenticated OpenClaw Gateway. Planner and
alignment use `openai/gpt-5.6-luna`; images use `openai/gpt-image-2`. Secret
values remain in the read-only runtime secret mount. Provider/model controls
are read-only and alternate-provider fallback is off.

The UI defaults to `zh-TW`. UI language (`openflipbook.uiLocale`) and generated
content language (`openflipbook.outputLocale`) are independent; changing the
UI to English does not change output language.

Known-good persisted acceptance data:

- session: `session_b3_live_8ce2bf1163044e9f92c878345dbbfec6`
- root: `2c3cfd01-e5be-410d-8c0a-037247ba5a85`
- graph: four persisted nodes

History resumes a persisted session at its latest page. Breadcrumb, minimap,
and branch beacons reopen persisted nodes; selecting an existing `h001` branch
does not generate. Back/forward follows the trail created in the current
browser visit.

Persisted/provider-facing `image_url` values remain unchanged for backward
compatibility. Normal browser presentation resolves `nodeId → image_key`
server-side through same-origin `/api/image/<nodeId>`, with raster MIME
allowlisting and `nosniff`. Phones, tablets, and other PCs do not access
client-local `localhost:9000`.

## Health, export, and recovery

- `/api/ready`: bounded backend `/health`, Mongo ping, and MinIO bucket probe;
  no model, provider, or SearXNG dispatch.
- `/api/status`: fixed provider route, breakers, health, and counters.
- `/status`: operator-readable configuration plus live Backend/Mongo/MinIO
  connectivity.

An **offline book** is one session plus a portable static viewer. An **owner
backup** contains all owner sessions, graphs, and required images with a
manifest of sizes and SHA-256 values. The offline book is for reading; the
owner backup is for disaster recovery.

Before an upgrade, use **設定 / 執行狀態 → 下載完整備份**, save the ZIP outside
the repository, record `sha256sum`, and perform a restore dry-run. Selecting a
backup validates only; mutation requires the explicit **確認還原** action. After
restore, require `/api/ready`, check History/Resume and representative images,
then create a fresh backup.

## Restart, upgrade, and rollback

Keep the current Git SHA and Web/backend image IDs. Build and replace one
stateless application service at a time:

```bash
scripts/nas-compose.sh build backend
scripts/nas-compose.sh up -d --no-deps backend
curl -fsS http://127.0.0.1:8787/health
scripts/nas-compose.sh build web
scripts/nas-compose.sh up -d --no-deps web
curl -fsS http://127.0.0.1:3000/api/ready
```

Do not restart Mongo or MinIO for an application-only upgrade. For rollback,
redeploy the recorded backend image first, require `/health`, then redeploy Web
and require `/api/ready`. Leave both data volumes and the bucket in place.
Never use `down -v`, drop collections, delete the bucket, or use a Git hard
reset as an operational rollback.

## Accepted browser matrix and exclusions

Real Chromium acceptance passed on persisted B4 data at 1440×900, 768×1024,
375×812, and 812×375 with no horizontal overflow, 44px primary/revisit targets,
same-origin loaded images, selectable DOM text, offline export, and zero
provider/search counter delta.

Intentional exclusions are exact:

- World Mode off
- AI video off
- AI prefetch off
- alternate provider fallback off
- provider/model controls read-only
- public multi-user/SaaS features out of scope

There are no remaining self-use blockers. The production build retains known
non-blocking Sentry/OpenTelemetry dynamic-import warnings; compile, typecheck,
tests, canonical Compose render, runtime acceptance, and clean-clone builds all
pass.
