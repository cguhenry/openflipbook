# NAS Maintenance and Upgrade Governance

This document is the operating baseline for the private, self-use NAS profile.
It is a maintenance runbook, not a feature roadmap.

## Accepted release and F baseline

The accepted E product release is commit
`df1ba055fc2d7f00838215ea2396881a6cf8045b`. The stable rollback/build tag is
`nas-self-use-v1.0.0` and must point exactly to that commit. The F maintenance
commit is not the product tag.

F pins only values proven by the accepted E build/runtime:

- Python base: `python@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf`
- Node base: `node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`
- Corepack: `0.35.0`
- Mongo NAS image: `mongo@sha256:4be76f674fc4b27859816811b8baa3c51830eb1dbf4ca81a51e26b79edd662ef`
- MinIO server: `minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`
- MinIO client: `minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727`
- Backend Python: `apps/modal-backend/requirements.nas.lock`, generated from the accepted E backend image.

`pnpm-lock.yaml` remains authoritative and frozen. The generic developer
Compose file's `mongo:7` path is intentionally outside the NAS profile; the
canonical NAS command always applies `docker-compose.nas.yml` and its pinned
Mongo image.

## Routine checklist

Run monthly and whenever the NAS host, Docker engine, OS, registry, upstream, or
dependency advisories change:

1. Confirm `main` is clean and equals `origin/main`.
2. Run `COMPOSE_PARALLEL_LIMIT=1 scripts/nas-maintenance-check.sh`.
3. Review container image IDs, RepoDigests, Compose ports, volumes, and the
   provider counters. Keep the backend/Web services serial; do not restart
   Mongo or MinIO for an application maintenance event.
4. Export a fresh owner backup, record its SHA-256, verify archive member hashes
   and CRC, and run the restore endpoint without confirmation. The dry-run must
   report `provider_calls=0`.
5. Review `pnpm audit --prod --json` and an ephemeral `pip-audit` result. Record
   reachability and compensating controls; do not perform broad upgrades.
6. Fetch and audit upstream as described below. Keep all audit output outside
   the repository's source tree when it is phase evidence.

When needed, repeat the checklist before and after a narrowly scoped security
patch, runtime rebuild, host migration, or rollback rehearsal. A real
maintenance event is required before opening a future phase.

## Upstream audit-only process

The canonical upstream is
`https://github.com/eren23/openflipbook.git`. Ensure the local Git remote is
named `upstream`, then fetch only its main ref:

```bash
git fetch upstream main --no-tags
python3 scripts/audit_upstream.py ...
```

Upstream review is audit-only in this baseline. Allowed operations are fetch,
diff, merge-base/ahead/behind calculation, and classification. A candidate is
classified as security/correctness review, potential NAS port candidate,
conflicting with NAS architecture, intentionally ignored, or test/doc only.
Protected NAS areas include deterministic PagePlan/hitmap/edge provenance,
session/history/backup/restore, offline export, zh-TW/i18n, readiness,
same-origin images, canonical Compose/volumes/ports, provider integration, and
NAS acceptance. Upstream is selectively ported after a separate decision; it is
never blindly merged, rebased, cherry-picked, pulled, or copied wholesale.

`scripts/nas-maintenance-check.sh --upstream` performs the local read-only
comparison against an already fetched `upstream/main`; it does not fetch.

## Dependency and security review

Web production dependencies are audited with the existing frozen lockfile:

```bash
pnpm audit --prod --json
```

Python production dependencies are audited in a disposable environment or
container with `pip-audit` against the NAS lock/requirements. Do not install
audit tooling into the NAS host Python. A reachable CRITICAL vulnerability in
the production path blocks closure unless a narrow compatible patch or a
documented compensating control removes reachability. HIGH findings require an
explicit reachability/patchability decision. MEDIUM/LOW findings are tracked
for a later maintenance event. Provider-only or intentionally disabled paths
are recorded separately and are not silently treated as NAS production use.

## Backup gate, deployment, and rollback

Before any application image build or deployment:

- export a fresh owner backup;
- save its SHA-256 under the maintenance evidence directory;
- verify ZIP safety, CRC, manifest coverage, and member hashes;
- run restore dry-run without the confirmation header;
- snapshot representative B4 state and provider counters.

Use the canonical Compose wrapper and `COMPOSE_PARALLEL_LIMIT=1`. Build and
deploy the backend first, verify `/health`, then build and deploy Web and verify
`/api/ready`. Do not use `docker compose down -v`. Do not restart, recreate,
upgrade, or delete Mongo/MinIO containers, volumes, or buckets for an
application-only maintenance event.

For rollback, redeploy only the stateless application services. The accepted E
images are:

- backend `sha256:8b094844c22f562c71dfaa3fbfa5fa97d443bc7d6be5200b7d83da1aa89653f0`
- Web `sha256:6e5ba161b64726009e999e26c4001f5dd2d572a8946d094160d5e02a4a6ea4a3`

Rollback backend first, verify health, then Web, verify readiness and the
persisted B4/history/image/offline behavior with unchanged counters. Roll
forward to the F backend and Web images in the same serial order and repeat the
same acceptance. Operational rollback is an image redeploy; never use Git
reset, checkout, restore, stash, revert, or production source mutation as a
rollback mechanism.

## Intentional exclusions

F does not add product features, enable World/video/AI-prefetch, or run
SearXNG, Luna planner, GPT Image 2, Luna alignment, or any other provider/model
call. It does not modify or restart OpenClaw, SearXNG, Caddy, Tailscale, Mongo,
or MinIO. It does not read or sync `pw.txt`. It does not broad-upgrade Web or
Python dependencies, change the frozen pnpm lock, or port upstream source
without a separate maintenance decision.

## Operator check

The tracked read-only check validates Git relation/state, canonical Compose,
expected NAS ports and external volumes, container state, readiness/status
without secrets, disabled feature flags, a representative persisted B4 session,
and a same-origin image. Optional checks are:

```bash
scripts/nas-maintenance-check.sh --json /path/to/F_MAINTENANCE_CHECK.json
scripts/nas-maintenance-check.sh --backup /path/to/owner-backup.zip
scripts/nas-maintenance-check.sh --upstream
```

The command never generates content, restarts services, mutates Git, fetches
upstream, or contacts provider/model endpoints.
