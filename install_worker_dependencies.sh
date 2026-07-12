#!/usr/bin/env bash
# install_worker_dependencies.sh — thin wrapper around
# `memoriahub node install-deps`.
#
# What this does: installs every dependency a Linux machine needs to become a
# fully-operational MemoriaHub worker node (ffmpeg/ffprobe, the npm native
# compute libraries, tesseract OCR language data, Docker, and the local
# compreface-core sidecar container) — checking what's already present and
# skipping it, installing/configuring whatever is missing, and ending with a
# clear pass/fail report.
#
# All of the real logic lives in the CLI's TypeScript implementation
# (`apps/cli/src/node/install-deps.ts` / `commands/node.ts`), NOT here — this
# script exists purely so someone can run one memorable command without
# knowing the exact `memoriahub` subcommand name.
#
# Requirements:
#   - Linux (the underlying command is Linux-only for now)
#   - The `memoriahub` CLI already installed and on PATH
#
# Usage:
#   ./install_worker_dependencies.sh [--dry-run] [--skip-compreface] [--compreface-port <port>]
#
# Any arguments given to this script are passed straight through to
# `memoriahub node install-deps`.
set -euo pipefail

if command -v memoriahub &>/dev/null; then
  exec memoriahub node install-deps "$@"
fi

echo "memoriahub CLI not found on PATH." >&2
echo "Install it first, then re-run this script:" >&2
echo "  curl -fsSL https://raw.githubusercontent.com/marinoscar/MemoriaHub/main/install.sh | bash" >&2
exit 1
