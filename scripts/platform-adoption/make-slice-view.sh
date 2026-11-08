#!/usr/bin/env bash
# Builds a throw-away "slice view" of EnterpriseAppBase for platform-drift.mjs:
# each MemoriaHub base module's packaged slice is copied to apps/api/src/<memoriahub-module>,
# so the API compares against the packaged slices instead of EAB's thin apps/api bindings.
# Pairs are <MemoriaHub apps/api/src dir>:<EAB packages/platform-api/src dir>.
# Usage: make-slice-view.sh <EAB root> <out dir>
set -euo pipefail
E=$1; V=$2; P=$E/packages/platform-api/src
rm -rf "$V"; mkdir -p "$V/apps/api/src" "$V/packages/shared" "$V/apps/cli"
cp "$E/packages/shared/identity.json" "$V/packages/shared/"
cp "$E/apps/cli/package.json" "$V/apps/cli/"
for pair in auth:identity/auth users:identity/users allowlist:identity/allowlist pat:identity/pat \
  device-auth:identity/device-auth health:host/health openapi:host/openapi \
  settings:settings email:email notifications:notifications enrichment:jobs \
  nodes:nodes storage:storage db-backup:db-backup doctor:doctor ai:ai android-app:android-app; do
  cp -r "$P/${pair#*:}" "$V/apps/api/src/${pair%%:*}"
done
