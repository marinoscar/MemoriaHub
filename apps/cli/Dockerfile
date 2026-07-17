# =============================================================================
# memoriahub-worker Dockerfile - Multi-stage build
# =============================================================================
# Build context: the REPOSITORY ROOT (see docker-compose.worker.build.yml and
# .github/workflows/deploy.yml). Required because apps/cli depends on the local
# npm workspace package @memoriahub/enrichment-compute — workspace linking needs
# the root package.json/lockfile and the member's package.json in one install,
# which an apps/cli-scoped context cannot provide. Same pattern as
# apps/api/Dockerfile.
#
# WORKDIR is /app (repo root) through the deps/build stages so npm workspaces
# resolve and apps/cli/tsconfig.json's "../../tsconfig.base.json" extends path
# lines up once apps/cli lands at /app/apps/cli. The worker stage keeps WORKDIR
# /app and invokes the built CLI by absolute path.
#
# This image runs the existing CLI worker headlessly (`node start --headless`):
# SIGTERM drains in-flight jobs without deregistering, and the node self-
# registers (register-or-reattach) from MEMORIAHUB_* env on start. See
# docs/worker-node-setup.md and docs/specs/distributed-nodes.md.
# =============================================================================

# -----------------------------------------------------------------------------
# Base stage
# -----------------------------------------------------------------------------
# glibc-based image (Debian) — REQUIRED: onnxruntime-node ships only glibc-linked
# prebuilt binaries which do not exist on Alpine/musl (GitHub issue #110). The
# worker runs the SAME CLIP visual-embedding + face compute as the server, so it
# needs the identical native stack.
FROM node:26-slim AS base
WORKDIR /app
# ffmpeg/ffprobe: video probe, frame extraction, and the HEIC transcode fallback
#   (packages/enrichment-compute transcodeToDecodableJpeg — retained as a safety
#   net now that sharp decodes HEIC natively; see the libvips note below).
# perl: required by exiftool-vendored at runtime for metadata_extraction.
# wget + ca-certificates: model downloads in the models stage (HTTPS needs the
#   CA bundle; Debian slim has no busybox wget).
# libvips42t64 + libheif1 + libde265-0 + libheif-plugin-libde265: a HEIF-enabled
#   system libvips so sharp (built from source against it via
#   SHARP_FORCE_GLOBAL_LIBVIPS in the deps stage) decodes HEIC/HEIF NATIVELY
#   instead of falling back to the ffmpeg transcode path (issue #128). sharp's
#   bundled libvips omits the HEVC/HEIC decoder for patent/licensing reasons;
#   Debian trixie's libvips42t64 is compiled with libheif, and trixie's libheif
#   uses plugin decoders, so the libheif-plugin-libde265 package (which pulls
#   libde265-0) is required for the actual HEVC decode. These are RUNTIME libs
#   and must live in `base` because the final `worker` stage is FROM base and the
#   source-built sharp addon dynamically links libvips-cpp.so.42 at runtime. Must
#   switch in lockstep with apps/api/Dockerfile so both executors decode HEIC via
#   the identical libvips build (cross-executor embedding parity — see #128/#108).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg perl wget ca-certificates \
      libvips42t64 libheif1 libde265-0 libheif-plugin-libde265 \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Dependencies stage
# -----------------------------------------------------------------------------
FROM base AS deps
# Build toolchain for native modules that may fall back to source compilation
# (better-sqlite3 via node-gyp when no prebuild matches the target arch). Kept
# in this stage only so the final image stays lean.
# pkg-config + libvips-dev: build-only deps for sharp's from-source addon build
# against the global HEIF-enabled libvips (see SHARP_FORCE_GLOBAL_LIBVIPS below).
# sharp locates libvips via `pkg-config --modversion vips-cpp`; libheif-dev is not
# needed here (libvips dlopens libheif internally).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ pkg-config libvips-dev \
    && rm -rf /var/lib/apt/lists/*

# Force sharp to build its native addon FROM SOURCE against the global
# (HEIF-enabled) libvips installed in the base stage, instead of using its
# bundled, HEIC-less libvips. Read at install time by sharp's install script,
# which runs here because this stage does NOT pass --ignore-scripts. Must switch
# together with apps/api/Dockerfile so both executors decode HEIC identically
# (issue #128).
ENV SHARP_FORCE_GLOBAL_LIBVIPS=1

# Root workspace manifests plus the two members the worker needs: apps/cli and
# the local @memoriahub/enrichment-compute it depends on. Manifests first keeps
# this layer cache-friendly.
COPY package*.json ./
COPY tsconfig.base.json ./
COPY apps/cli/package.json ./apps/cli/package.json
COPY packages/enrichment-compute ./packages/enrichment-compute/
# Scripts ENABLED (unlike the API image): the worker needs the native binaries
# actually built/downloaded — better-sqlite3 (node-gyp/prebuild), onnxruntime-node
# (postinstall binary fetch, the CLIP runtime), sharp/@vladmandic/human/tesseract.
# Under buildx the install runs on the target platform, so per-arch (amd64/arm64)
# native binaries resolve automatically.
RUN npm install

# Build the shared enrichment-compute workspace package so its dist/ exists
# before apps/cli (which imports it) is compiled.
RUN npm run build -w @memoriahub/enrichment-compute

# -----------------------------------------------------------------------------
# Models stage — bake parity models into the image (reproducible / air-gap)
# -----------------------------------------------------------------------------
# Values MUST match apps/api NodesService.getModelManifest() so a node's compute
# is numerically identical to the server's. CLIP + Human are sha256-verified and
# MANDATORY (build fails if a download is corrupt/missing). Tesseract eng data is
# best-effort — a bad/absent bake only degrades social_media_detection to
# Tier-1-only (the OCR path resolves to null and the job still runs), never fails.
FROM base AS models
# CLIP ViT-B/32 vision model (onnxruntime-node, int8-quantized, 512-d) → models root.
ENV CLIP_URL=https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx
ENV CLIP_SHA256=583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299
RUN mkdir -p /app/models && \
    wget -q -O /app/models/clip-vit-b32-vision-quantized.onnx "$CLIP_URL" && \
    echo "$CLIP_SHA256  /app/models/clip-vit-b32-vision-quantized.onnx" | sha256sum -c - \
      || { echo "FATAL: CLIP model download failed or hash mismatch"; exit 1; }
# @vladmandic/human face models (blazeface-back detector + faceres descriptor) → models/human.
RUN mkdir -p /app/models/human && cd /app/models/human && \
    wget -q -O blazeface-back.json https://github.com/vladmandic/human-models/raw/main/models/blazeface-back.json && \
    wget -q -O blazeface-back.bin  https://github.com/vladmandic/human-models/raw/main/models/blazeface-back.bin && \
    wget -q -O faceres.json        https://github.com/vladmandic/human-models/raw/main/models/faceres.json && \
    wget -q -O faceres.bin         https://github.com/vladmandic/human-models/raw/main/models/faceres.bin && \
    printf '%s\n' \
      'a765f7b2a6c1d841ecc0b0686e5f51b141b39b7bcdf2888542dc9d9fc4384a87  blazeface-back.json' \
      'dc9a97fdc50bc43216554bdd69aa3e7b9361a519ee7bdd996a2f69a98a6f9b72  blazeface-back.bin' \
      '5b83d49c0385d2e68a05122441b94226313677cae9fcc40b9587ad50079eb4df  faceres.json' \
      '2c7d2d62b76c97528b736527aa09d310ea71743c9e3e79fb6c62d4b2d73af79b  faceres.bin' \
      | sha256sum -c - \
      || { echo "FATAL: Human model download failed or hash mismatch"; exit 1; }
# Tesseract English traineddata (Tier-2 OCR for social_media_detection) →
# models/tesseract, where createOcrEngine's langDir (MODELS_DIR/tesseract) reads it.
# Best-effort: OCR degrades to Tier-1-only if this is missing.
RUN mkdir -p /app/models/tesseract && \
    wget -q -O /app/models/tesseract/eng.traineddata.gz \
      https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz \
      || echo "WARN: tesseract eng traineddata bake failed — OCR will run Tier-1-only or download at runtime"

# -----------------------------------------------------------------------------
# Build stage — compile the CLI
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages /app/packages
COPY --from=deps /app/tsconfig.base.json /app/tsconfig.base.json
COPY apps/cli ./apps/cli
# Build from within the package dir (not `-w` from root) so the root
# package.json is not required in this stage — mirrors apps/api/Dockerfile.
WORKDIR /app/apps/cli
RUN npm run build
WORKDIR /app

# -----------------------------------------------------------------------------
# Worker stage — final runtime image
# -----------------------------------------------------------------------------
FROM base AS worker
# node_modules + packages must land at the same absolute paths they were
# installed/built at (npm workspace symlinks are relative:
# node_modules/@memoriahub/enrichment-compute -> ../../packages/enrichment-compute).
COPY --from=deps  /app/node_modules /app/node_modules
COPY --from=deps  /app/packages /app/packages
COPY --from=build /app/apps/cli/dist /app/apps/cli/dist
COPY --from=build /app/apps/cli/package.json /app/apps/cli/package.json
COPY --from=models /app/models /app/models

# Headless container config. MEMORIAHUB_STATE_DIR relocates the writable state
# (pidfile/socket/logs/local sqlite) off the read-only image into a per-replica
# dir; MODELS_DIR/FACE_HUMAN_MODEL_PATH point at the baked models so ensureModels
# verifies them in place instead of re-downloading; MEMORIAHUB_HEADLESS makes
# `node start` self-register and drain-without-deregister on SIGTERM.
# SHARP_FORCE_GLOBAL_LIBVIPS: keep set at runtime too so sharp resolves the
# system HEIF-enabled libvips (matches the deps stage that built its addon), and
# any runtime `npm rebuild` keeps building against global libvips (issue #128).
ENV MEMORIAHUB_STATE_DIR=/data \
    MODELS_DIR=/app/models \
    FACE_HUMAN_MODEL_PATH=/app/models/human \
    MEMORIAHUB_HEADLESS=1 \
    NODE_ENV=production \
    SHARP_FORCE_GLOBAL_LIBVIPS=1

# Per-replica writable state dir, owned by the unprivileged runtime user. The
# baked models must also be writable by that user because ensureModels may
# repair/rewrite a file in place during verification.
RUN mkdir -p /data && chown -R node:node /data /app/models
USER node

# SIGTERM (Docker's default stop signal) reaches PID 1 directly with the exec
# form, so the CLI's headless signal handler drains and exits cleanly. compose
# sizes stop_grace_period; a job killed past the grace window is recovered by
# the server lease reaper.
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/apps/cli/dist/index.js", "node", "start", "--headless"]
