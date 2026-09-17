#!/usr/bin/env bash
# Deploy the worker. Skips the container image build (and Docker entirely)
# when the Dockerfile and container config haven't changed since the last
# deploy that built one - `wrangler deploy --containers-rollout=none` still
# ships the Worker, it just leaves the running container image alone.
#
# Usage:
#   npm run deploy            # smart: build the image only if it changed
#   npm run deploy:image       # force an image rebuild this time
set -euo pipefail
cd "$(dirname "$0")/.."

FORCE=0
if [[ "${1:-}" == "--with-image" ]]; then
  FORCE=1
fi

npm run build

HASH_FILE=".deploy-image.hash"
CURRENT_HASH=$(cat Dockerfile wrangler.jsonc | shasum -a 256 | awk '{print $1}')

if [[ "$FORCE" == "1" ]]; then
  echo "==> Forcing container image rebuild"
  npx wrangler deploy
  echo "$CURRENT_HASH" > "$HASH_FILE"
elif [[ -f "$HASH_FILE" && "$(cat "$HASH_FILE")" == "$CURRENT_HASH" ]]; then
  echo "==> Dockerfile/wrangler.jsonc unchanged, deploying Worker only (no Docker)"
  npx wrangler deploy --containers-rollout=none
else
  echo "==> Dockerfile/wrangler.jsonc changed (or no prior deploy recorded), building container image"
  npx wrangler deploy
  echo "$CURRENT_HASH" > "$HASH_FILE"
fi
