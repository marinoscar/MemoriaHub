# =============================================================================
# API Dockerfile - Multi-stage build
# =============================================================================
# Build context: the REPOSITORY ROOT (see infra/compose/base.compose.yml:
# `context: ../.., dockerfile: apps/api/Dockerfile`). This is required
# because apps/api depends on the local npm workspace package
# @memoriahub/enrichment-compute (packages/enrichment-compute) — npm
# workspace linking needs the root package.json/lockfile and the workspace
# member's package.json to be visible in the same install, which an
# apps/api-scoped context cannot provide.
#
# WORKDIR is /app (repo root) through the deps stage so npm install resolves
# workspaces correctly and apps/api/tsconfig.json's "../../tsconfig.base.json"
# extends path lines up once apps/api is copied to /app/apps/api. Runtime
# stages then switch WORKDIR to /app/apps/api so npm scripts, CMD entries,
# and relative env-var defaults (e.g. MODELS_DIR="./data/models") behave
# exactly as they did when the context was apps/api alone.
# =============================================================================

# -----------------------------------------------------------------------------
# Base stage
# -----------------------------------------------------------------------------
# glibc-based image (Debian) — REQUIRED: onnxruntime-node ships only
# glibc-linked prebuilt binaries (libonnxruntime.so.1 needs ld-linux-x86-64.so.2),
# which do not exist on Alpine/musl. Building on node:*-alpine here silently
# degrades server-side CLIP visual embeddings (near-duplicate detection falls
# back to hash-only). See GitHub issue #110.
FROM node:26-slim AS base
WORKDIR /app
# OpenSSL for Prisma; ffmpeg for video processing; wget + ca-certificates for
# the Human model download below (busybox wget is builtin on Alpine but absent
# on Debian slim, and HTTPS fetches need the CA bundle).
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ffmpeg wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Dependencies stage
# -----------------------------------------------------------------------------
FROM base AS deps
# Root workspace manifests plus the two workspace members apps/api needs:
# itself, and the local @memoriahub/enrichment-compute package it depends on.
# Copying manifests (not full source) first keeps this layer cache-friendly.
COPY package*.json ./
COPY tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/prisma ./apps/api/prisma/
COPY apps/api/scripts ./apps/api/scripts/
COPY packages/enrichment-compute ./packages/enrichment-compute/
# Using npm install since this is a workspace package without its own lock file
RUN npm install --ignore-scripts

# Build the shared enrichment-compute workspace package so its dist/ is
# present before apps/api (which imports it) is compiled or run.
RUN npm run build -w @memoriahub/enrichment-compute

# Set dummy DATABASE_URL for Prisma generate (actual connection not needed at build time)
RUN cd apps/api && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

# Download @vladmandic/human model files (blazeface-back detector + faceres
# descriptor) for offline in-process face detection. The build FAILS if any
# file is missing so we never ship an incomplete model set silently.
ENV HUMAN_MODELS_BASE=https://vladmandic.github.io/human-models/models
RUN mkdir -p /app/models/human && \
    for f in blazeface-back.json blazeface-back.bin faceres.json faceres.bin; do \
      wget -q -O "/app/models/human/$f" "$HUMAN_MODELS_BASE/$f" || { echo "FATAL: failed to download Human model $f"; exit 1; }; \
    done && \
    echo "Human models bundled:" && ls -la /app/models/human

# -----------------------------------------------------------------------------
# Development stage
# -----------------------------------------------------------------------------
FROM base AS development
# node_modules and packages/ must land at the same absolute paths they were
# installed/built at (/app/node_modules, /app/packages) — npm workspace
# linking uses relative symlinks (node_modules/@memoriahub/enrichment-compute
# -> ../../packages/enrichment-compute) that would break if the layout shifted.
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages /app/packages
COPY --from=deps /app/tsconfig.base.json /app/tsconfig.base.json
COPY --from=deps /app/models /app/models
COPY apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# -----------------------------------------------------------------------------
# Build stage
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages /app/packages
COPY --from=deps /app/tsconfig.base.json /app/tsconfig.base.json
COPY apps/api ./apps/api
WORKDIR /app/apps/api
RUN npm run build

# -----------------------------------------------------------------------------
# Production stage
# -----------------------------------------------------------------------------
FROM base AS production
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages /app/packages
COPY --from=deps /app/models /app/models
COPY --from=deps /app/tsconfig.base.json /app/tsconfig.base.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/prisma ./apps/api/prisma/
COPY apps/api/scripts ./apps/api/scripts/
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
