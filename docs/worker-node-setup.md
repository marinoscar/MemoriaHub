# Worker Node Setup & Troubleshooting

| Field | Value |
|-------|-------|
| **Version** | 1.1 |
| **Last Updated** | July 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Quick Start: Container Bundle (Recommended)](#quick-start-container-bundle-recommended)
3. [Automated Setup (`memoriahub node install-deps`) — Advanced / Legacy, Native Install](#2-automated-setup-memoriahub-node-install-deps)
4. [System Prerequisites](#3-system-prerequisites)
5. [Native Compute Dependencies](#4-native-compute-dependencies)
6. [Matching the Server's Face-Detection Provider (CompreFace) — Advanced / Legacy](#5-matching-the-servers-face-detection-provider-compreface)
7. [Model Manifest & Downloads](#6-model-manifest--downloads)
8. [Registering and Running](#7-registering-and-running)
9. [Reading `node doctor` Output](#8-reading-node-doctor-output)
10. [Troubleshooting](#9-troubleshooting)

This is a practical setup/troubleshooting companion to the [Distributed Nodes spec](specs/distributed-nodes.md), which covers the feature's architecture, security model, and API contract in full. This document does not repeat that content — it exists to answer "what do I install, and what do I do when `node doctor` says something is wrong."

For a complete configuration-settings reference across the API and worker container, see [Worker Container Configuration Reference](worker-container-config.md).

**Two setup paths exist.** The containerized worker bundle (this document's Quick Start, below) is the recommended path for anything beyond a single ad-hoc machine: it needs no native dependency installation on the host at all, since ffmpeg, the npm native compute libraries, tesseract's OCR language data, and the CLIP/Human model files are all baked into the published image. §2 onward documents the native, non-container install — kept as the advanced/legacy path for a machine that can't or shouldn't run Docker, or for understanding/customizing exactly what the container bundle automates.

---

## 1. Overview

A worker node (`apps/cli`'s `memoriahub node start`) needs four things before it is fully operational: the native compute libraries (`sharp`, `onnxruntime-node`, `@vladmandic/human` + its TensorFlow.js backends, `tesseract.js`), the `ffmpeg`/`ffprobe` system binaries, the model files those libraries load at runtime, and — optionally, for a household running a node unattended — a persistent daemon or systemd service. `memoriahub node doctor` (a CLI command, and identically a full-screen TUI screen under Tools ▸ Worker Node ▸ Node doctor) is the single command that tells you exactly which of these four things is missing and where, distinguishing a library that merely **resolves** (installed) from one that has been proven to **actually work** (operational) — see §8 for why that distinction matters and is the most common source of confusion.

The containerized worker bundle described in the Quick Start immediately below satisfies all four of these automatically — a fresh container is dependency-complete, model-complete, and always-on by construction, with no doctor pass needed before first use. §2 onward is the native install path, where doctor is the primary tool for finding what's still missing.

---

## Quick Start: Container Bundle (Recommended)

The fastest, most consistent way to add compute to the enrichment fleet is the pre-built worker container image (`ghcr.io/marinoscar/memoriahub-worker`) plus the root-level `docker-compose.worker.yml` bundle — not the native `node install-deps` path described in §2 onward, which remains available for a machine that can't or shouldn't run Docker (see that section's own note below). This is the recommended path for anything beyond a single ad-hoc laptop: it needs no native dependency installation on the host at all, since ffmpeg, the npm native compute libraries, tesseract's OCR language data, and the CLIP/Human model files are all baked into the image at build time.

### Steps

1. **Mint a node credential.** In the web UI, go to `/admin/settings/nodes` → Node Credentials → Create. Copy the raw `nod_`-prefixed token shown — it is displayed only once. This is a durable, `/api/nodes/*`-only credential (never valid for media/settings/admin endpoints); a Personal Access Token also still works here for back-compat, but a node credential is the least-privilege option and is what this quick start assumes. See the [Distributed Nodes spec §13](specs/distributed-nodes.md#13-durable-node-credentials-nod_-tokens) for the full credential model.
2. **Copy the compose bundle to the host.** From the repo root, copy `docker-compose.worker.yml` and `.env.worker.example` (renamed to `.env.worker`) to the machine that will run the worker(s).
3. **Configure `.env.worker`.** At minimum set `MEMORIAHUB_URL` (your API's base URL, e.g. `https://your-domain/api`), `MEMORIAHUB_TOKEN` (the `nod_` token from step 1), and a per-host `MEMORIAHUB_NODE_NAME` (must be unique per machine — see the per-replica identity note below).
4. **Start the bundle.**
   ```bash
   docker compose -f docker-compose.worker.yml --env-file .env.worker up -d
   ```
   This starts a health-gated `compreface-core` sidecar (see below) and one `memoriahub-worker` service instance.
5. **Scale as needed.**
   ```bash
   docker compose -f docker-compose.worker.yml --env-file .env.worker up -d --scale memoriahub-worker=N
   ```

### `MEMORIAHUB_*` environment reference

The worker container is configured entirely through environment variables — there is no interactive `node register`/`node start` step to run by hand; the container's entrypoint runs `node start --headless` at boot.

| Variable | Description |
|----------|--------------|
| `MEMORIAHUB_URL` | Base URL of the API the node connects to |
| `MEMORIAHUB_TOKEN` | Bearer credential — a `nod_` node credential (preferred) or a PAT |
| `MEMORIAHUB_NODE_ID` | Existing node ID to resume, if known; normally left unset and let register-or-reattach (below) resolve it |
| `MEMORIAHUB_NODE_NAME` | This machine/replica's display name; **must be distinct per host/replica** — see below |
| `MEMORIAHUB_CONCURRENCY` | Local worker slot count for this node |
| `MEMORIAHUB_ELIGIBLE_TYPES` | CSV of job types this node advertises (defaults to everything the local capability probe supports) |
| `MEMORIAHUB_POLL_INTERVAL_MS` | Claim-loop poll interval |
| `MEMORIAHUB_FACE_PROVIDER` | `human` or `compreface` — the bundle sets this to `compreface` and points it at the bundled sidecar |
| `MEMORIAHUB_COMPREFACE_URL` | Base URL of the local `compreface-core` sidecar; the bundle sets this to `http://compreface-core:3000` |
| `MEMORIAHUB_STATE_DIR` | Relocates the whole state directory (config, pidfile, socket, logs, models) — the bundle maps this to the `/data` volume |
| `MEMORIAHUB_HEADLESS` | `1` implies `--headless`; the worker image's entrypoint always runs headless regardless |
| `MODELS_DIR` | Overrides where model resolution looks; the image bakes models at `/app/models` already, so this is only needed to point at a different/mounted model directory |

`loadConfig()` (`apps/cli/src/config.ts`) overlays these env vars over any `~/.memoriahub/config.json` on disk (env wins), and synthesizes a full config from env alone when no config file exists at all — this is what lets the container run with zero interactive setup.

**`workflow_execute_batch` needs nothing from this document.** Unlike every other type in `MEMORIAHUB_ELIGIBLE_TYPES`'s default set, the Media Workflow Automation batch-execution job type (`workflow_execute_batch`, epic #138) has zero capability requirements — no native library, no model file, no `ffmpeg`/`ffprobe` — because it never touches media bytes or runs a model; it only declares intended per-item outcomes from a frozen action list, and the API re-does the actual work authoritatively server-side (see the [Workflow Automation spec §11](specs/workflows.md#11-node-execution-computepersist-split)). It is therefore eligible on the leanest possible worker install, including a bare native `node install-deps`-free checkout, and `node doctor` always reports it ready. See the [Distributed Nodes spec §8](specs/distributed-nodes.md#8-node-eligible-job-types) job-type table for where it sits relative to the model/native-dependency-bearing types this document is primarily about.

### The bundled CompreFace sidecar

`docker-compose.worker.yml` runs a health-gated, multi-process `compreface-core` (`exadel/compreface-core:1.2.0-mobilenet`) alongside the worker service; the worker's `depends_on` waits for `condition: service_healthy` before starting. `UWSGI_PROCESSES` defaults to `${COMPREFACE_PROCESSES:-2}` in the bundle — raise it in `.env.worker` on a host with more cores to get real parallelism across concurrent face-detection jobs (see §5.2 below for the equivalent core-aware sizing guidance on the native install path).

### Per-replica identity

**Each replica registers as its own node.** Whether you scale via `--scale memoriahub-worker=N` or run the bundle on several separate machines, every running worker container needs a distinct identity — set a unique `MEMORIAHUB_NODE_NAME` per host/replica. Two containers sharing one node identity will fight over job leases (`job not owned by this node` errors), the same failure mode §7's "Each machine = its own node registration" note describes for the native path.

**Do NOT share the `/data` state volume between replicas.** The state directory holds a pidfile and a Unix-domain-socket IPC channel that assume a single running instance; two containers pointed at the same volume will collide on both. Give each replica its own volume/mount.

### Re-attach on restart, and SIGTERM drain

Registration is idempotent: re-registering under the same name re-attaches to the existing node record (refreshing hostname/platform/cliVersion/eligibleTypes/concurrency and marking it `online`) instead of creating a duplicate — so a replaced or restarted container keeps its identity and job history. On `docker compose ... down`, `docker stop`, or a container restart, the worker receives `SIGTERM`; running headless it **drains** in-flight jobs and exits WITHOUT deregistering, so the node record persists and the next container start simply re-attaches to it. (A non-headless `node start`, and an explicit `node stop`/`node deregister`, still deregister — that only matters for the native install path below, since the container image always runs headless.) See the [Distributed Nodes spec §12](specs/distributed-nodes.md#12-registration-lifecycle-register-or-reattach-and-offline-pruning) for the full register-or-reattach contract.

### Image parity and air-gapped models

The worker image is published multi-arch (amd64 + arm64) and tagged with the exact CLI version that built it (`cli-<version>`) — pulling a specific tag guarantees the same compute stack (and therefore the same embeddings) as a server running that CLI version, per the parity guarantees in [distributed-nodes.md §7.3](specs/distributed-nodes.md#73-four-mechanisms-to-guarantee-parity--as-built). CLIP, Human, and the tesseract OCR data are baked into the image at `/app/models` at build time, so a freshly-started container is air-gap friendly — nothing needs to be downloaded from Hugging Face/GitHub at startup.

For a local source build instead of the published `ghcr.io` image, use `docker-compose.worker.build.yml` as an overlay.

### Pairing with the API

On the API side, set `ENRICHMENT_WORKER_MODE=system` so the API's own in-process worker stops competing for media-compute job types and leaves them entirely to this fleet, while still running the server-only jobs a node cannot (they need direct DB access). See the [Distributed Nodes spec §14](specs/distributed-nodes.md#14-worker-modes-and-the-lease-reaper) for the full mode semantics.

---

## 2. Automated Setup (`memoriahub node install-deps`)

> **Advanced / legacy path.** This section (and §3–§6 below) documents the native, non-container install — useful for a single ad-hoc machine, a platform without Docker, or fine-grained customization. For a production fleet, the containerized worker bundle in [Quick Start: Container Bundle (Recommended)](#quick-start-container-bundle-recommended) above is the recommended path and needs none of this.

Everything in §3 through §6 below can be handled in one command for the common case: a Linux machine with Node.js and the `memoriahub` CLI already installed. `memoriahub node install-deps` checks what's already present and skips it, installs and configures whatever is missing (using `sudo` where required, always announcing the exact command before running it), and finishes with a fresh `node doctor`-style pass/fail report so you can immediately see what changed. It is Linux-only for now — see §3 and §5 for the manual macOS/Windows/non-apt-distro paths.

```bash
memoriahub node install-deps
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Announce every privileged/install action the command would take without actually executing any of them |
| `--skip-compreface` | Skip the Docker + `compreface-core` install/verify steps entirely — useful if you only want Human-provider dependencies |
| `--compreface-port <port>` | Port to bind the local `compreface-core` container to (default `3000`, matching `http://localhost:3000` used elsewhere in this doc) |

The sweep runs in order: reinstall any missing/broken npm native compute dependencies (§4), install `ffmpeg`/`ffprobe` via `apt` if missing (Debian/Ubuntu only — other distros get an unsupported-for-automation note for this one step, and the rest of the sweep still runs), initialize the OCR engine once with network access so tesseract's language data downloads as a side effect (§4), fetch the CLIP/Human model files via the existing model-manifest flow (skipped with a clear message if the CLI isn't logged in yet — run `memoriahub login` first, then re-run), and — unless `--skip-compreface` — install Docker via `apt` if missing, pull/start the `compreface-core` container (§5.1), and verify it actually responds at `/status` with a short retry loop. The exit code is non-zero if any step genuinely failed; skipped, unsupported, or already-fine steps never fail the run.

**What this command does NOT do:** it doesn't install Node.js or the CLI itself — those are prerequisites, since you're already running `memoriahub`. It also doesn't force a `faceProvider` choice on your node's configuration: even after successfully setting up CompreFace, you still opt in explicitly via `--face-provider compreface` on `node register`/`node start` (§5.3) — this command only makes CompreFace *available*, it doesn't change what your node currently advertises.

The rest of this document — §3 onward — is the manual, step-by-step reference for exactly what this command automates. Reach for it when the automated path doesn't apply (a non-Debian/Ubuntu distro, macOS, Windows), when you want to understand or customize a step, or when troubleshooting a step that failed (§9).

There is also a standalone entrypoint at the repo root, `install_worker_dependencies.sh` — a thin wrapper for anyone who wants a single memorable command. It requires the CLI to already be installed (it exits with install instructions if `memoriahub` isn't found on `PATH`) and simply delegates to `memoriahub node install-deps`, passing through any flags you give it.

There is deliberately no TUI screen for this command: it streams live system-install output (`apt-get`, `docker pull`) that doesn't compose safely with the TUI's render loop, so it is headless-only — run it from a real terminal.

---

## 3. System Prerequisites

| Dependency | Minimum version | Notes |
|------------|------------------|-------|
| Node.js | 20 | Enforced by the installer (see `apps/cli/README.md`'s Requirements table) |

**ffmpeg / ffprobe.** Required for `video_face_detection` and `social_media_detection` (see §4's requirements table). Not bundled — the CLI shells out to binaries on `PATH`. Install with the same per-OS commands the CLI's `convert` command already documents (`apps/cli/README.md`, "Convert (transcode videos to MP4)" section):

- macOS: `brew install ffmpeg`
- Debian/Ubuntu: `sudo apt install ffmpeg`
- Windows: `winget install ffmpeg` (or `choco install ffmpeg`)

`ffmpeg` and `ffprobe` are checked as two **separate** capabilities by `node doctor` (`apps/cli/src/node/capabilities.ts`'s `detectCapabilities()` probes each independently via `<bin> -version`). A typical ffmpeg install places both binaries on `PATH` together, but verify with `ffprobe -version` as well as `ffmpeg -version` if `node doctor` reports only one of the two as missing.

---

## 4. Native Compute Dependencies

All of the libraries below are declared as `optionalDependencies` in the CLI's own `package.json`, pinned to the exact versions the shared `packages/enrichment-compute` package and the root `package.json`'s `overrides` block also pin (so a node's compute is numerically identical to the server's — see [distributed-nodes.md §7.3](specs/distributed-nodes.md#73-four-mechanisms-to-guarantee-parity--as-built)):

| Library | Version (pinned) | Purpose | Job types that need it |
|---------|-------------------|---------|--------------------------|
| `sharp` | `0.35.1` | Image decode/encode, used as the shared pixel-prep step for every image-touching job | `face_detection`, `video_face_detection`, `duplicate_detection`, `metadata_extraction`, `thumbnail_regen`, `thumbnail_repair`, `auto_tagging` |
| `onnxruntime-node` | `1.27.0` | Runs the CLIP ViT-B/32 ONNX model for visual near-duplicate embeddings | `duplicate_detection` — **optional**: without it, duplicate detection still runs in dHash-only degraded mode (`JOB_TYPE_REQUIREMENTS['duplicate_detection']` only hard-requires `sharp`) |
| `@tensorflow/tfjs` + `@tensorflow/tfjs-backend-wasm` | `4.22.0` | TensorFlow.js WASM backend `@vladmandic/human` runs on | `face_detection`, `video_face_detection` (transitively, via `human`) |
| `@vladmandic/human` | `3.3.6` | Face detection model | `face_detection`, `video_face_detection` — **required**: `JOB_TYPE_REQUIREMENTS` lists `human` as hard-required for both |
| `tesseract.js` | `7.0.0` | OCR fallback (Tier 2) for social-media video detection | `social_media_detection` — **optional**: `JOB_TYPE_REQUIREMENTS['social_media_detection']` only hard-requires `ffprobe`; without tesseract the job runs Tier-1-only (container-metadata/filename rules, no OCR) |

These install automatically as part of a normal `memoriahub` install (curl installer or local-clone build) — there is no separate step to run before `node start` on a supported platform. Because they're `optionalDependencies`, a platform where one fails to build/download does not break the rest of the CLI; that job type is simply excluded from `eligibleTypes` (or runs degraded, for the two optional entries above) until the dependency resolves.

### Installed vs. operational, per library

`node doctor`'s step 2 (`detectCapabilities()`) only proves a library **resolves** (`require.resolve`, no side effects). Step 3 (`runOperationalSelfTests()` in `apps/cli/src/node/self-test.ts`) proves it actually **works** by attempting a real minimal operation. Here is what "installed but not yet operational" means for each, and how to fix it:

- **`sharp` not operational.** `testSharp()` decodes a tiny synthetic raw pixel buffer and re-encodes it as JPEG. A failure here almost always means a wrong/incompatible prebuilt native binary for the current platform/Node version (the same class of problem `apps/cli/README.md`'s install-size section documents for `better-sqlite3`). Remediation: rebuild from source with `npm_config_build_from_source=true bash install.sh` (see `apps/cli/README.md`, "Install size and native dependencies"), after installing a C compiler toolchain if one is not already present (`sudo apt install build-essential python3` on Debian/Ubuntu, `xcode-select --install` on macOS).
- **`onnxruntime` (CLIP) not operational.** `testClip()` first checks whether the model file `clip-vit-b32-vision-quantized.onnx` exists locally; if it doesn't, the result is reported `available: false` with detail "CLIP model not downloaded yet" — this is expected on a node that has never run `node start`/`node doctor` with a working API connection, since models are fetched lazily (§6). Remediation: run `node doctor` or `node start` once against a reachable API server so `ensureModels()` fetches it, or place the file manually per §6's air-gapped path. If the model file IS present and the self-test still fails, that's a genuine broken install (corrupt download, wrong platform build of `onnxruntime-node`) rather than a missing-model case — re-download the model or reinstall the CLI.
- **`human` (face detector) not operational.** `testHuman()` checks whether the Human model directory (`~/.memoriahub/models/human/`, or `FACE_HUMAN_MODEL_PATH` if overridden) exists; if not, it reports "Human model files not present" — same lazy-download category as CLIP above, same remediation (run `node start`/`node doctor` once against the API, or manually place the four files listed in §6).
- **`tesseract` not operational — the case this guide exists for.** `testTesseract()` (`apps/cli/src/node/self-test.ts`) checks whether the configured language(s)' trained-data file(s) — `<lang>.traineddata` or `<lang>.traineddata.gz` — exist under `~/.memoriahub/models/tesseract/` (English, `eng`, by default). Unlike CLIP/Human, tesseract's language data is **not** part of the sha256-pinned model manifest (§6) — it is downloaded/cached by `tesseract.js` itself the first time OCR actually runs on real data, not proactively by `ensureModels()`. "Language data not present" therefore means: this node has the `tesseract.js` package installed and resolvable, but has never yet successfully completed a real OCR pass to populate `~/.memoriahub/models/tesseract/`. Fix: ensure the node has outbound network access and write permission to `~/.memoriahub/models/tesseract/`, then let a real `social_media_detection` job run through Tier 2 once (or wait for the OCR engine's own first-use download) — after that, the language data is cached on disk and `node doctor` will report `tesseract` as operational on every subsequent run. Until then, `social_media_detection` still works in Tier-1-only (metadata/filename) mode; it is degraded, not broken.
- **ffmpeg/ffprobe not installed at all.** These are left as the existing binary-execution presence probe rather than an operational self-test (see the `self-test.ts` module docstring: generating a synthetic media asset to decode would add real complexity for a check that already executes the real binary). If `node doctor` reports either as unavailable, see §3's per-OS install commands.

---

## 5. Matching the Server's Face-Detection Provider (CompreFace)

> **Advanced / legacy path.** This section covers configuring CompreFace by hand for a native (non-container) node install. The container bundle's `docker-compose.worker.yml` already runs a health-gated, multi-process `compreface-core` sidecar and points the worker at it automatically (`MEMORIAHUB_FACE_PROVIDER=compreface`) — see [Quick Start: Container Bundle (Recommended)](#quick-start-container-bundle-recommended) above. Read on only if you're setting up a native install or want to understand what the bundle automates.

By default, a worker node performs face detection with the keyless Human provider (`@vladmandic/human`, 1024-dimensional embeddings), regardless of which face-detection provider the server itself is actively configured to use (`PUT /api/face/features/detection` — `human`, `compreface`, or `rekognition`). If the server's active provider is `compreface` (128-d ArcFace MobileFaceNet embeddings) rather than `human`, a node still defaulting to Human will keep working, but its face rows land in a different embedding space than the rest of the circle's faces — person-matching cosine similarity assumes one consistent embedding space per circle, so cross-provider faces can silently fail to match, or worse, produce spurious matches. The API's `FaceDetectionService.warnOnProviderMismatch` logs a warning when it detects this (never blocking) — see the [Distributed Nodes spec](specs/distributed-nodes.md) for the full embedding-space rationale. This section does not re-derive that explanation; it covers the practical fix.

If your server runs with `compreface` as the active face provider, configure your worker nodes to match it exactly by opting into CompreFace as the node's own local face-detection provider.

### 5.1 Install Docker

Face detection via CompreFace is the only capability in this whole guide that requires a container runtime — every other native dependency (`sharp`, `onnxruntime-node`, `@vladmandic/human`, `tesseract.js`) is a plain npm package installed alongside the CLI (see §5.6 below for how CompreFace's container-based model differs from those). To opt a node into `--face-provider compreface`, install Docker on that node machine first so it can run the `compreface-core` sidecar container.

- **macOS**: Docker Desktop is the standard path — download it from [docker.com](https://www.docker.com/products/docker-desktop/), or `brew install --cask docker`. Either way, launch Docker Desktop once after installing to complete setup; the Docker daemon runs as part of Docker Desktop, not as a separate background service.
- **Debian/Ubuntu**: Docker's official apt repository install (`docker-ce`, `docker-ce-cli`, `containerd.io` — see [Docker's own install docs](https://docs.docker.com/engine/install/ubuntu/)) is the most current, officially-supported path. `sudo apt install docker.io` is a simpler distro-packaged alternative that also works, though it may lag behind in version — use your judgement based on how current you need Docker to be. After installing, add your user to the `docker` group so `docker` commands don't require `sudo` on every invocation:
  ```bash
  sudo usermod -aG docker $USER
  ```
  then log out and back in (or run `newgrp docker`) for the group membership to take effect. Enable the daemon to start on boot:
  ```bash
  sudo systemctl enable --now docker
  ```
- **Windows**: Docker Desktop with the WSL2 backend is the standard recommended setup. If the node itself runs inside WSL — a common setup for this CLI, per the WSL guidance elsewhere in this guide (see §9's Troubleshooting table) — Docker Desktop's WSL2 integration must be enabled for that specific distro (Docker Desktop ▸ Settings ▸ Resources ▸ WSL Integration).

Verify the install before moving on:

```bash
docker --version
docker run hello-world
```

`docker --version` should print a version string. `docker run hello-world` should pull and run Docker's canonical smoke-test image, ending with a "Hello from Docker!" message — that confirms both that Docker is installed and that the daemon is actually running and reachable, not just that the CLI binary exists.

### 5.2 Prerequisite: run your own local CompreFace sidecar

Docker must be installed and running first — see §5.1.

A node opting into CompreFace runs its OWN local `compreface-core` container — the same image the server itself runs (see `infra/compose/base.compose.yml`'s `compreface-core` service block). The node's compute calls this container directly at `http://localhost:<port>`, NOT proxied through the server: the server's own sidecar has no port exposed externally by design, and routing a node's face-detection calls through the server would defeat the whole point of a distributed worker.

**Multi-process inference is now the default.** `UWSGI_PROCESSES` now defaults to a core-aware value, `min(cores - 2, 6)`, instead of the previously-hardcoded `1`; `UWSGI_THREADS` stays `1`. This matters because CompreFace serves one request per uwsgi worker process — a single process serialized ALL face detection onto roughly one core regardless of the node's configured concurrency. Multiple processes give true parallelism; threads alone would just contend on Python's GIL, so they don't help here. Measured impact on an 8-core/32GB laptop: bumping to ~6 processes cut `face_detection` job time from roughly 17–20s down to roughly 2–3s — about an 8x improvement.

**Auto-restart.** The container that `memoriahub node install-deps` creates now runs with `--restart unless-stopped`, so it survives a crash or host reboot without manual intervention.

`memoriahub node install-deps` now sets all of this up automatically. The manual `docker run` recipe below remains the reference/manual path for people who want to do it by hand or customize further — consistent with how §2 frames the automated-vs-manual relationship elsewhere in this doc ("§3 onward — is the manual, step-by-step reference for exactly what this command automates").

New `node install-deps` flags for CompreFace resource tuning:

| Flag | Description |
|------|-------------|
| `--compreface-processes <n>` | Override the core-aware default (`min(cores - 2, 6)`) |
| `--compreface-memory <size>` | e.g. `4g`; maps to Docker's `--memory` flag |
| `--compreface-cpus <n>` | e.g. `4`; maps to Docker's `--cpus` flag |
| `--compreface-recreate` | Remove and recreate an EXISTING container so new process/restart/resource settings actually take effect |

**Recreate-vs-restart nuance.** This is easy to get wrong, so call it out explicitly: on a plain re-run of `node install-deps`, a currently-**running** container is left completely untouched — you must explicitly pass `--compreface-recreate` to pick up new settings (process count, restart policy, resource limits). A **stopped** container, however, IS now recreated automatically on a plain re-run; previously it was just `docker start`-ed, which cannot apply new flags at all, so recreation is required to change uwsgi process count, restart policy, or resource limits on a stopped container too. `compreface-core` is stateless (no volumes), so recreating it is always safe — no data is lost either way.

`memoriahub node install-deps` now does all of the above automatically, so the manual recipe below is for people who want to do it by hand or customize further. Start it once per node machine, sizing `UWSGI_PROCESSES` to `min(cores - 2, 6)` for your machine (the example below uses 6, appropriate for an 8-core+ host):

```bash
docker run -d --name compreface-core -p 3000:3000 \
  --restart unless-stopped \
  -e UWSGI_PROCESSES=6 -e UWSGI_THREADS=1 \
  exadel/compreface-core:1.2.0-mobilenet
```

Optionally, pull the image separately first to confirm it downloads successfully, as a step distinct from actually starting the container — useful for diagnosing a slow/failed pull vs. a container-runtime problem:

```bash
docker pull exadel/compreface-core:1.2.0-mobilenet
```

Confirm it's reachable:

```bash
curl http://localhost:3000/status
```

A healthy response reports `"status": "OK"`.

### 5.3 CLI usage

Two new flags on `node register` and `node start`:

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--face-provider <human\|compreface>` | `human`, `compreface` | `human` | Which face-detection provider this node uses for `face_detection`/`video_face_detection` jobs |
| `--compreface-url <url>` | any URL | `http://localhost:3000` | Base URL of the node's local `compreface-core` sidecar; only consulted when `--face-provider compreface` |

```bash
memoriahub node register --face-provider compreface --compreface-url http://localhost:3000
memoriahub node start --face-provider compreface
```

Both settings are stored in local node config only (`faceProvider`, `comprefaceUrl`) — never sent to the server, which learns only the resulting `eligibleTypes` the node ends up advertising. Omitting both flags is a no-op change: the default (`human`, zero config) preserves today's behavior exactly.

The equivalent TUI path is Tools ▸ Worker Node ▸ Register node / Node config — both screens gain a face-provider toggle alongside the existing concurrency and job-type fields.

### 5.4 Hard-fail behavior — no silent fallback to Human

If a node is configured `faceProvider: 'compreface'` but its local sidecar is unreachable, `node doctor` reports the `compreface` capability unavailable, and `face_detection`/`video_face_detection` are **NOT READY** on that node — it simply stops advertising those job types as eligible, rather than silently falling back to Human. This is deliberate: a silent fallback would reintroduce the exact embedding-space mismatch this feature exists to prevent (see the overview above). See §9 (Troubleshooting) below for the exact symptom and fix.

This same hard-fail principle also applies to the warm-up window at start time, not just to an already-known-unreachable sidecar. When a node's face provider is `compreface` and its eligible types include a face job (`face_detection`/`video_face_detection`), `node start` now **blocks** on a bounded wait (~40 seconds) polling CompreFace's `/status` endpoint until it reports healthy, before the node claims any jobs. This exists because CompreFace takes roughly 15–30 seconds to load its model on (re)create; starting immediately would let the node claim face jobs before the sidecar is actually ready. Previously this silently ran those jobs on the in-process Human provider instead — about 8x slower, with no error surfaced, and (per this section's whole premise) landing in the wrong embedding space vs. the rest of the circle.

If CompreFace does not become healthy within the ~40s budget, `node start` now **fails outright** rather than silently falling back to Human. The operator must fix the sidecar (see §9 troubleshooting) or explicitly pass `--face-provider human` if that's the intended provider.

The actively-selected face provider is now logged at start, and surfaced in `memoriahub node status` output as a new "Face provider" line — present in both the live/IPC status view (a running daemon) and the offline/config status view (reading local config when no daemon is running).

### 5.5 `node doctor` coverage

`node doctor` (CLI and TUI) gains one new capability row, `compreface`, reported using the exact same installed-vs-operational model described in §8 for every other capability: **installed** means the configured `comprefaceUrl` responds at all to a `GET /status` call; **operational** means that response actually reports `status: 'OK'`. Like every other capability, a clean, fully-healthy node collapses this row into the one-line summary count; only a real problem expands it with detail. (The `node start` warm-up wait described in §5.4 uses this same `/status` check.)

### 5.6 How this differs from the CLIP/Human model-file pattern

Unlike the CLIP ONNX model or the Human face-detector files documented in §6 below, CompreFace isn't a downloadable model file `ensureModels()` fetches into `~/.memoriahub/models/`. It's a separate, long-running local service — a Docker container — that the operator starts and keeps running themselves. There is nothing for `node start`/`node doctor` to download or sha256-verify here; the capability check is a live HTTP reachability probe against whatever `comprefaceUrl` is configured, not a file-presence check.

---

## 6. Model Manifest & Downloads

`GET /api/nodes/models/manifest` (`jobs:read` permission) returns a bare array of model entries the node should have locally to serve its `eligibleTypes` — each with a real, computed `sha256` and `bytes` value (`apps/api/src/nodes/nodes.service.ts`'s `getModelManifest()`). As of this writing the manifest lists five files: the CLIP ONNX vision model (`clip-vit-b32-vision-quantized.onnx`) and four Human face-detector files (`blazeface-back.json`, `blazeface-back.bin`, `faceres.json`, `faceres.bin`).

`ensureModels()` (`apps/cli/src/node/models.ts`) downloads and sha256-verifies each manifest entry into `~/.memoriahub/models/` (overridable via the `MODELS_DIR` environment variable), skipping any file already present and valid. It is called automatically by `node start`, `node doctor`, and the equivalent TUI flows — there is no separate "download models" command. On success it points `process.env.MODELS_DIR` (and `FACE_HUMAN_MODEL_PATH`) at the local directory for the rest of the process's lifetime.

**Verified path note:** both the Human model files (`targetSubdir: 'human'`, landing at `~/.memoriahub/models/human/`) and the CLIP manifest entry (`targetSubdir: ''`, landing directly at `~/.memoriahub/models/clip-vit-b32-vision-quantized.onnx`) are consistent end-to-end with where the consuming code looks for them — `apps/cli/src/node/compute/face-detection.ts` and `self-test.ts`'s `testHuman()` for the Human files, and `self-test.ts`'s `testClip()` and `apps/cli/src/node/compute/duplicate-detection.ts` for the CLIP model. No manual workaround is needed. (This previously required a manual workaround for the CLIP entry specifically — an earlier `targetSubdir: 'models'` value caused a double-nested download path, `~/.memoriahub/models/models/clip-vit-b32-vision-quantized.onnx` — fixed in the API's manifest; see `apps/api/src/nodes/nodes.service.ts`'s `getModelManifest()`, CLIP entry's `targetSubdir: ''`.)

**Air-gapped / offline installs:** for the Human files, place them manually at `~/.memoriahub/models/human/<name>` before starting the node. For the CLIP model, place it directly at `~/.memoriahub/models/clip-vit-b32-vision-quantized.onnx` (the path the compute/self-test code reads) — `ensureModels()`'s own existing-file check (`isValid()`) will skip re-downloading a file already present there with a matching size/sha256. This mirrors the equivalent server-side escape hatch documented for the API's own copy of this model in [duplicate-detection.md](specs/duplicate-detection.md#41-model-loading-and-lifecycle): "place the model file manually at `MODELS_DIR/clip-vit-b32-vision-quantized.onnx` before starting."

---

## 7. Registering and Running

Dependency setup (this document) is only half the picture — once `node doctor` reports the capabilities you need as operational, register and start the node:

```bash
memoriahub node register
memoriahub node start          # foreground
memoriahub node start --daemon # background
memoriahub node service install # always-on systemd user service
```

Equivalent TUI menu items: Tools ▸ Worker Node ▸ Register node / Start worker (background) / Node service (systemd). See `apps/cli/README.md`'s ["Worker Nodes (distributed compute)"](../apps/cli/README.md#worker-nodes-distributed-compute) section for full command reference, flags, and the TUI dashboard's own doctor overlay — this document's job is dependency setup, not day-to-day operation.

**Per-machine concurrency tuning.** `memoriahub node set-concurrency <n>` (and the `--concurrency` flag on `node register`/`node start`) lets you match a node's concurrency to the machine it runs on. Note that with the new multi-process CompreFace default (§5.2), face detection can now actually use multiple cores in parallel, which changes what a sensible concurrency value looks like on a given machine.

**Each machine = its own node registration.** Every physical machine must run `node register` itself — do NOT clone `~/.memoriahub/config.json` from one machine to another. The config file embeds a `nodeId`; two machines sharing the same `nodeId` will fight over job leases, surfacing as `job not owned by this node` errors. This is the same lease-ownership guard documented elsewhere in the project (see CLAUDE.md's Distributed Nodes section) as protecting against late/duplicate submissions from a reaped node — a cloned config creates an analogous but self-inflicted conflict between two live machines, both alive at once.

---

## 8. Reading `node doctor` Output

The single most important concept in this whole guide: **installed** and **operational** are different claims, and `node doctor` reports both.

- **Installed** (step 2 of the sweep) means the native module resolves via `require.resolve` — the package is present in `node_modules` (or, for `ffmpeg`/`ffprobe`, the binary runs). It proves nothing about whether the library actually works on this machine, or whether its model files have been downloaded.
- **Operational** (step 3, `runOperationalSelfTests()`) means a real minimal operation was attempted and succeeded — `sharp` actually decoded and re-encoded a pixel buffer, the CLIP model actually produced a 512-dimensional embedding, the Human detector actually ran inference on a synthetic image, tesseract actually initialized and tore down a real OCR worker. A capability can be installed but not operational — most commonly because its model file/language data hasn't been fetched yet (§4), or, more rarely, because the installed native binary is broken for this platform.

Job-type readiness (step 4) is gated on the **operational** result, not mere presence — a node whose `sharp` package resolves but crashes on first real use is correctly reported not-ready for every job type that needs it, rather than silently claiming jobs it cannot actually process.

Both the CLI command (`memoriahub node doctor`) and the TUI screen (Tools ▸ Worker Node ▸ Node doctor, and the dashboard's `[r]` quick-doctor overlay) run the identical six-step sweep and share the same classification logic (`apps/cli/src/node/doctor-summary.ts`). The report display is **collapsed by default**: capabilities and job types that are fully healthy (installed AND operational, or ready) are rolled up into a one-line summary count, and only rows with a real issue — not installed, installed-but-not-operational, or not job-ready — are expanded with their full detail message. This means a clean node's doctor output is short; a node with a genuine problem gets the detail surfaced without having to scroll past everything that's already fine.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `docker: command not found` or `docker run` fails with a daemon-connection error | Docker isn't installed, or the Docker daemon isn't running | See §5.1 for per-OS install instructions; on Linux confirm the daemon is running with `sudo systemctl status docker` |
| `compreface` capability shows unavailable / `face_detection` not ready when faceProvider is set to compreface | local `compreface-core` container isn't running or isn't reachable at the configured URL | start/check the container (`docker ps`, `curl http://localhost:3000/status`), or fix `comprefaceUrl` if it's using a non-default port |
| `tesseract: installed / not yet operational — language data not present` | `tesseract.js`'s trained-data file(s) for the configured language(s) haven't been downloaded/cached yet at `~/.memoriahub/models/tesseract/` — this only happens on real first-use, not proactively | Ensure network access and write permission to `~/.memoriahub/models/tesseract/`, then let a real OCR pass run once (a `social_media_detection` job reaching Tier 2). Until then, `social_media_detection` runs Tier-1-only (degraded, not broken). See §4. |
| A capability shows `no` (not installed) at all | The corresponding `optionalDependencies` entry failed to build/download for this platform — most commonly a missing native compile toolchain | Install the toolchain: `sudo apt install build-essential python3` (Debian/Ubuntu) or `xcode-select --install` (macOS) — the same guidance `apps/cli/README.md` documents for `better-sqlite3` — then reinstall/rebuild (`npm_config_build_from_source=true bash install.sh` if a prebuilt binary genuinely isn't available for this platform/Node version). |
| `API error 404: Cannot GET /api/nodes/models/manifest` (or any `/api/nodes/*` 404) | Most likely explanation: the connected API server predates the Distributed Nodes feature, or a reverse-proxy path rewrite is stripping/misrouting the `/api` prefix. This is not typically a CLI bug. | Confirm the API server has been updated/redeployed to a version that includes the `/api/nodes/*` routes, and double-check the `serverUrl` in `~/.memoriahub/config.json` points at the correct `/api`-prefixed base. |
| `node status`/`node list` shows the node as "not recognized by server" (a registered node ID the server 404s/403s on) | The node record was deleted or deregistered server-side — e.g. an admin removed it via `DELETE /api/admin/nodes/:id` on the Worker Nodes admin page, or another process ran `node deregister` for it | Run `memoriahub node register` again to create a fresh registration; the old node ID cannot be revived. |
| `node service install` refuses, or reports systemd unavailable (WSL) | WSL distros often don't have a per-user systemd instance running by default (`systemctl --user show-environment` fails) | Enable systemd via `[boot]\nsystemd=true` in `/etc/wsl.conf`, then `wsl --shutdown` from Windows to restart the distro — or skip systemd entirely and use `memoriahub node start --daemon` instead. See [distributed-nodes.md §9.3](specs/distributed-nodes.md#93-worker-daemon-systemd-service-and-tui-attach) and `apps/cli/README.md`'s "Always-on service" section. |
| `node service install` refuses on Windows outright | systemd has no Windows equivalent — `service install` is a no-op there by design, not a bug | Use `memoriahub node start --daemon` instead. |
| Face jobs slow / appear to run on Human despite `--face-provider compreface` | The CompreFace warm-up race at start time, or the provider not actually being selected as configured | Check the "Face provider" line in `memoriahub node status` output to confirm which provider is actually active; confirm `node start` waited for CompreFace to report healthy before claiming jobs (see §5.4); verify the sidecar directly with `curl http://localhost:3000/status` (or the configured `comprefaceUrl`). |
| `job not owned by this node` errors on a node that was recently set up | `~/.memoriahub/config.json` was copied/cloned from another machine instead of running `node register` fresh, so two machines share one `nodeId` and are fighting over job leases | Run `memoriahub node register` on the affected machine to get its own distinct node identity (do not reuse a cloned config across machines — see §7). |
