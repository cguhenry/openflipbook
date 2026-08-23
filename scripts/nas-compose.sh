#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export COMPOSE_PARALLEL_LIMIT=1

exec docker compose \
  --project-name openflipbook-a0 \
  --project-directory "$repo_dir" \
  -f "$repo_dir/docker-compose.yml" \
  -f "$repo_dir/docker-compose.nas.yml" \
  "$@"
