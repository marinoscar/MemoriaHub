# =============================================================================
# API Dockerfile - Multi-stage build
# =============================================================================
# Build context: the REPOSITORY ROOT (see infra/compose/base.compose.yml:
# `context: ../.., dockerfile: apps/api/Dockerfile`). This is required
# because apps/api depends on the local npm workspace package
# @marinoscar/memoriahub-compute (packages/memoriahub-compute) — npm
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
# -----------------------------------------------------------------------------
# libvips stage: libvips 8.18.3 compiled WITH libheif/libde265 (RETRO-J, #593/#616)
# -----------------------------------------------------------------------------
# sharp 0.35.x only builds against a system libvips >= 8.18.3 and Debian trixie
# ships 8.16, so the distro package cannot be used; sharp's bundled libvips has no
# HEVC decoder. Compile it once here (scripts/docker/build-libvips.sh, shared by
# apps/api and apps/cli so both executors link the IDENTICAL build: embedding
# parity) and copy /opt/vips into `base`.
FROM node:26-slim AS vips
COPY scripts/docker/build-libvips.sh /tmp/build-libvips.sh
RUN /tmp/build-libvips.sh

FROM node:26-slim AS base
WORKDIR /app
# OpenSSL for Prisma; ffmpeg for video processing (and the HEIC transcode
# fallback, retained as a safety net); wget + ca-certificates for the Human model
# download below (busybox wget is builtin on Alpine but absent on Debian slim,
# and HTTPS fetches need the CA bundle).
# perl: required by exiftool-vendored at runtime — on POSIX the package ships the
#   ExifTool *script* (exiftool-vendored.pl), not a compiled binary, so a perl
#   interpreter must be on PATH or the EXIF carryover stamp applied to AI-enhanced
#   images (ExifCarryoverService) silently degrades to a no-op. Must stay in
#   lockstep with apps/cli/Dockerfile, which installs perl for the same reason.
# postgresql-client-17 (from PGDG): provides pg_dump / pg_restore for the
#   PostgreSQL database backup engine (epic #339, issue #341). RUNTIME
#   dependency — the `production` stage is FROM base and the backup runner
#   spawns these binaries at run time.
#
#   THE INVARIANT is `client major >= server major`: pg_dump refuses to dump a
#   server newer than itself. A NEWER client is fine; an OLDER one can never
#   back this server up. The pin tracks the pgvector/pgvector:pg17 server.
#
#   Installed from apt.postgresql.org (PGDG) rather than the stock Debian
#   archive because the stock archive only ever carries the CURRENT default
#   major for that release — so a pinned `postgresql-client-NN` is guaranteed
#   to vanish on the next base-image bump (issue #364: the `-16` pin broke the
#   build outright when node:*-slim moved to trixie, whose default is 17).
#   PGDG publishes every supported major for the current Debian release, which
#   decouples this pin from base-image drift. Taking an unversioned
#   `postgresql-client` instead would make the shipped major non-deterministic
#   across rebuilds.
#
#   The lockstep requirement is NO LONGER enforced by this comment alone — see
#   src/db-backup/pg-version.util.ts, which gates the backup runner, the
#   restore pre-flight, and the Doctor `core.pgClientVersion` check against the
#   LIVE server version, plus the CI gate in .github/workflows/deploy.yml.
#
#   wget + ca-certificates are installed in a first pass so the PGDG signing key
#   can be fetched; the armored .asc is consumed directly via apt's `signed-by=`,
#   so no gnupg (and no separate curl) is needed.
# libvips42t64 + libheif1 + libde265-0 + libheif-plugin-libde265: a HEIF-enabled
#   system libvips so sharp (rebuilt from source against it in the deps stage via
#   SHARP_FORCE_GLOBAL_LIBVIPS) decodes HEIC/HEIF NATIVELY instead of falling back
#   to ffmpeg (issue #128). sharp's bundled libvips omits the HEVC/HEIC decoder
#   for patent/licensing reasons; Debian trixie's libvips42t64 is compiled with
#   libheif, and trixie's libheif uses plugin decoders, so libheif-plugin-libde265
#   (pulling libde265-0) is required for the HEVC decode. RUNTIME libs — must live
#   in `base` because the `production` stage is FROM base and the source-built
#   sharp addon links libvips-cpp.so.42 at runtime. Must switch in lockstep with
#   apps/cli/Dockerfile so both executors decode HEIC via the identical libvips
#   build (cross-executor embedding parity — see #128/#108).
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget ca-certificates \
    && install -d /usr/share/postgresql-common/pgdg \
    && wget -qO /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
         https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends \
      openssl ffmpeg perl \
      postgresql-client-17 \
      libvips42t64 libheif1 libde265-0 libheif-plugin-libde265 libhwy1t64 \
    && rm -rf /var/lib/apt/lists/*

# The source-built libvips 8.18.3 (HEIF/HEVC enabled). The apt libvips42t64
# above stays only to pull in the shared-library dependency closure; the
# LD_LIBRARY_PATH entry makes the dynamic loader prefer /opt/vips for libvips
# itself, which is what the sharp addon (built against it below) links.
COPY --from=vips /opt/vips /opt/vips
ENV LD_LIBRARY_PATH=/opt/vips/lib \
    PKG_CONFIG_PATH=/opt/vips/lib/pkgconfig \
    CPATH=/opt/vips/include

# -----------------------------------------------------------------------------
# Dependencies stage
# -----------------------------------------------------------------------------
FROM base AS deps
# Build toolchain + headers for sharp's from-source addon build against the
# global HEIF-enabled libvips (issue #128). Build-only: the runtime stages copy
# node_modules (with the built addon) out of this stage, not this toolchain, so
# the final image stays lean. sharp locates libvips via
# `pkg-config --modversion vips-cpp`; node-gyp is provided by npm.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ pkg-config libglib2.0-dev libexpat1-dev libjpeg-dev libpng-dev libwebp-dev libtiff-dev libheif-dev libexif-dev liblcms2-dev librsvg2-dev libhwy-dev libcgif-dev libspng-dev libimagequant-dev libfftw3-dev \
    && rm -rf /var/lib/apt/lists/*

# Root workspace manifests plus the two workspace members apps/api needs:
# itself, and the local @marinoscar/memoriahub-compute package it depends on.
# Copying manifests (not full source) first keeps this layer cache-friendly.
COPY package*.json ./
COPY tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/prisma ./apps/api/prisma/
# Prisma 7 reads the schema folder (prisma/schema) and the migrations path from this file; without
# it `prisma generate` finds no schema. Found by the PR-time image build (images.yml).
COPY apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY apps/api/scripts ./apps/api/scripts/
COPY packages/memoriahub-compute ./packages/memoriahub-compute/
# The wire-schema package (zod only) both the API and the CLI import by subpath.
COPY packages/memoriahub-contract ./packages/memoriahub-contract/
# The domain's host ports (RETRO-J4): the injection tokens apps/api binds to the platform in
# src/platform-memoriahub/. Built below; it imports no platform package.
COPY packages/memoriahub-api ./packages/memoriahub-api/
# The domain schema package (a dev dependency of apps/api: its command installs the
# fragments; no build step, nothing runs from it in the image). Present so
# `npm install` links the workspace instead of looking the private name up.
COPY packages/memoriahub-db ./packages/memoriahub-db/
# The compute package's build ends with write-dist-stubs.mjs, which lives in the
# shared package tooling folder (../../scripts/memoriahub-packages).
COPY scripts/memoriahub-packages/write-dist-stubs.mjs ./scripts/memoriahub-packages/write-dist-stubs.mjs
COPY packages/shared ./packages/shared/
# Using npm install since this is a workspace package without its own lock file
RUN npm install --ignore-scripts

# The main install runs with --ignore-scripts, and sharp 0.35 has no install script
# anyway, so sharp keeps its bundled HEIC-less libvips until it is built from source
# in the step below.

# Build sharp's native addon from source against the HEIF-enabled libvips in
# /opt/vips (RETRO-J, #593/#616). sharp 0.35 has NO install script, so neither
# `npm install` nor `npm rebuild sharp --build-from-source` builds anything: the
# build is its own `install/build.js` (= `npm run build`), which needs
# node-addon-api and node-gyp, both only devDependencies of sharp. They are
# installed in a scratch dir and exposed through PATH/NODE_PATH so nothing leaks
# into node_modules or the lockfile. The build fails loudly if pkg-config reports
# a libvips below sharp's minimum, and the final check proves the addon really
# links the source-built libvips with HEIF support (not the bundled one).
RUN mkdir /tmp/sharp-tools && cd /tmp/sharp-tools \
 && npm init -y >/dev/null \
 && npm install --no-audit --no-fund node-addon-api@8.9.0 node-gyp@12.4.0 \
 && pkg-config --cflags vips-cpp && pkg-config --libs vips-cpp \
 && cd /app/node_modules/sharp \
 && PATH=/tmp/sharp-tools/node_modules/.bin:$PATH NODE_PATH=/tmp/sharp-tools/node_modules \
    SHARP_FORCE_GLOBAL_LIBVIPS=1 node install/build.js \
 && rm -rf /tmp/sharp-tools \
 && node -e "require('/app/node_modules/sharp/src/build/Release/sharp-linux-x64-0.35.3.node');const s=require('/app/node_modules/sharp');const v=s.versions.vips;console.log('sharp libvips',v,'heif',JSON.stringify(s.versions.heif));if(!/^8\\.18\\./.test(v)||!s.format.heif.input.buffer){process.exit(1)}"

# Build the shared memoriahub-compute workspace package so its dist/ is
# present before apps/api (which imports it) is compiled or run.
RUN npm run build -w @marinoscar/memoriahub-compute && npm run build -w @marinoscar/memoriahub-contract && npm run build -w @marinoscar/memoriahub-api

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
# linking uses relative symlinks (node_modules/@marinoscar/memoriahub-compute
# -> ../../packages/memoriahub-compute) that would break if the layout shifted.
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
# Keep set at runtime so sharp resolves the system HEIF-enabled libvips (matches
# the addon built in the deps stage) and any runtime rebuild stays global (#128).
ENV SHARP_FORCE_GLOBAL_LIBVIPS=1
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages /app/packages
COPY --from=deps /app/models /app/models
COPY --from=deps /app/tsconfig.base.json /app/tsconfig.base.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/prisma ./apps/api/prisma/
COPY apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY apps/api/scripts ./apps/api/scripts/
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
