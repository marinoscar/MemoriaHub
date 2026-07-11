# Worker Node Setup & Troubleshooting

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | July 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Prerequisites](#2-system-prerequisites)
3. [Native Compute Dependencies](#3-native-compute-dependencies)
4. [Model Manifest & Downloads](#4-model-manifest--downloads)
5. [Registering and Running](#5-registering-and-running)
6. [Reading `node doctor` Output](#6-reading-node-doctor-output)
7. [Troubleshooting](#7-troubleshooting)

This is a practical setup/troubleshooting companion to the [Distributed Nodes spec](distributed-nodes.md), which covers the feature's architecture, security model, and API contract in full. This document does not repeat that content — it exists to answer "what do I install, and what do I do when `node doctor` says something is wrong."

---

## 1. Overview

A worker node (`apps/cli`'s `memoriahub node start`) needs four things before it is fully operational: the native compute libraries (`sharp`, `onnxruntime-node`, `@vladmandic/human` + its TensorFlow.js backends, `tesseract.js`), the `ffmpeg`/`ffprobe` system binaries, the model files those libraries load at runtime, and — optionally, for a household running a node unattended — a persistent daemon or systemd service. `memoriahub node doctor` (a CLI command, and identically a full-screen TUI screen under Tools ▸ Worker Node ▸ Node doctor) is the single command that tells you exactly which of these four things is missing and where, distinguishing a library that merely **resolves** (installed) from one that has been proven to **actually work** (operational) — see §6 for why that distinction matters and is the most common source of confusion.

---

## 2. System Prerequisites

| Dependency | Minimum version | Notes |
|------------|------------------|-------|
| Node.js | 20 | Enforced by the installer (see `apps/cli/README.md`'s Requirements table) |

**ffmpeg / ffprobe.** Required for `video_face_detection` and `social_media_detection` (see §3's requirements table). Not bundled — the CLI shells out to binaries on `PATH`. Install with the same per-OS commands the CLI's `convert` command already documents (`apps/cli/README.md`, "Convert (transcode videos to MP4)" section):

- macOS: `brew install ffmpeg`
- Debian/Ubuntu: `sudo apt install ffmpeg`
- Windows: `winget install ffmpeg` (or `choco install ffmpeg`)

`ffmpeg` and `ffprobe` are checked as two **separate** capabilities by `node doctor` (`apps/cli/src/node/capabilities.ts`'s `detectCapabilities()` probes each independently via `<bin> -version`). A typical ffmpeg install places both binaries on `PATH` together, but verify with `ffprobe -version` as well as `ffmpeg -version` if `node doctor` reports only one of the two as missing.

---

## 3. Native Compute Dependencies

All of the libraries below are declared as `optionalDependencies` in the CLI's own `package.json`, pinned to the exact versions the shared `packages/enrichment-compute` package and the root `package.json`'s `overrides` block also pin (so a node's compute is numerically identical to the server's — see [distributed-nodes.md §7.3](distributed-nodes.md#73-four-mechanisms-to-guarantee-parity--as-built)):

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
- **`onnxruntime` (CLIP) not operational.** `testClip()` first checks whether the model file `clip-vit-b32-vision-quantized.onnx` exists locally; if it doesn't, the result is reported `available: false` with detail "CLIP model not downloaded yet" — this is expected on a node that has never run `node start`/`node doctor` with a working API connection, since models are fetched lazily (§4). Remediation: run `node doctor` or `node start` once against a reachable API server so `ensureModels()` fetches it, or place the file manually per §4's air-gapped path. If the model file IS present and the self-test still fails, that's a genuine broken install (corrupt download, wrong platform build of `onnxruntime-node`) rather than a missing-model case — re-download the model or reinstall the CLI.
- **`human` (face detector) not operational.** `testHuman()` checks whether the Human model directory (`~/.memoriahub/models/human/`, or `FACE_HUMAN_MODEL_PATH` if overridden) exists; if not, it reports "Human model files not present" — same lazy-download category as CLIP above, same remediation (run `node start`/`node doctor` once against the API, or manually place the four files listed in §4).
- **`tesseract` not operational — the case this guide exists for.** `testTesseract()` (`apps/cli/src/node/self-test.ts`) checks whether the configured language(s)' trained-data file(s) — `<lang>.traineddata` or `<lang>.traineddata.gz` — exist under `~/.memoriahub/models/tesseract/` (English, `eng`, by default). Unlike CLIP/Human, tesseract's language data is **not** part of the sha256-pinned model manifest (§4) — it is downloaded/cached by `tesseract.js` itself the first time OCR actually runs on real data, not proactively by `ensureModels()`. "Language data not present" therefore means: this node has the `tesseract.js` package installed and resolvable, but has never yet successfully completed a real OCR pass to populate `~/.memoriahub/models/tesseract/`. Fix: ensure the node has outbound network access and write permission to `~/.memoriahub/models/tesseract/`, then let a real `social_media_detection` job run through Tier 2 once (or wait for the OCR engine's own first-use download) — after that, the language data is cached on disk and `node doctor` will report `tesseract` as operational on every subsequent run. Until then, `social_media_detection` still works in Tier-1-only (metadata/filename) mode; it is degraded, not broken.
- **ffmpeg/ffprobe not installed at all.** These are left as the existing binary-execution presence probe rather than an operational self-test (see the `self-test.ts` module docstring: generating a synthetic media asset to decode would add real complexity for a check that already executes the real binary). If `node doctor` reports either as unavailable, see §2's per-OS install commands.

---

## 4. Model Manifest & Downloads

`GET /api/nodes/models/manifest` (`jobs:read` permission) returns a bare array of model entries the node should have locally to serve its `eligibleTypes` — each with a real, computed `sha256` and `bytes` value (`apps/api/src/nodes/nodes.service.ts`'s `getModelManifest()`). As of this writing the manifest lists five files: the CLIP ONNX vision model (`clip-vit-b32-vision-quantized.onnx`) and four Human face-detector files (`blazeface-back.json`, `blazeface-back.bin`, `faceres.json`, `faceres.bin`).

`ensureModels()` (`apps/cli/src/node/models.ts`) downloads and sha256-verifies each manifest entry into `~/.memoriahub/models/` (overridable via the `MODELS_DIR` environment variable), skipping any file already present and valid. It is called automatically by `node start`, `node doctor`, and the equivalent TUI flows — there is no separate "download models" command. On success it points `process.env.MODELS_DIR` (and `FACE_HUMAN_MODEL_PATH`) at the local directory for the rest of the process's lifetime.

**Verified path note:** the Human model files (`targetSubdir: 'human'`) land at `~/.memoriahub/models/human/`, matching where `apps/cli/src/node/compute/face-detection.ts` and `self-test.ts`'s `testHuman()` look for them — this path is consistent end-to-end. The CLIP manifest entry, however, is tagged `targetSubdir: 'models'` in the current server-side manifest (`apps/api/src/nodes/nodes.service.ts`), which makes `ensureModels()` write it to `~/.memoriahub/models/models/clip-vit-b32-vision-quantized.onnx` — one directory level deeper than where `self-test.ts`'s `testClip()` and `apps/cli/src/node/compute/duplicate-detection.ts` actually look for it (`~/.memoriahub/models/clip-vit-b32-vision-quantized.onnx`, no extra `models/` segment). If `node doctor` keeps reporting the CLIP model as "not downloaded yet" even after a successful `node start`/`node doctor` run that logged the file as downloaded, check for it one directory level down and move/copy it up to `~/.memoriahub/models/clip-vit-b32-vision-quantized.onnx` as a workaround (see also the Troubleshooting entry in §7).

**Air-gapped / offline installs:** for the Human files, place them manually at `~/.memoriahub/models/human/<name>` before starting the node. For the CLIP model, place it directly at `~/.memoriahub/models/clip-vit-b32-vision-quantized.onnx` (the path the compute/self-test code actually reads, per the note above) — `ensureModels()`'s own existing-file check (`isValid()`) will skip re-downloading a file already present there with a matching size/sha256. This mirrors the equivalent server-side escape hatch documented for the API's own copy of this model in [duplicate-detection.md](duplicate-detection.md#41-model-loading-and-lifecycle): "place the model file manually at `MODELS_DIR/clip-vit-b32-vision-quantized.onnx` before starting."

---

## 5. Registering and Running

Dependency setup (this document) is only half the picture — once `node doctor` reports the capabilities you need as operational, register and start the node:

```bash
memoriahub node register
memoriahub node start          # foreground
memoriahub node start --daemon # background
memoriahub node service install # always-on systemd user service
```

Equivalent TUI menu items: Tools ▸ Worker Node ▸ Register node / Start worker (background) / Node service (systemd). See `apps/cli/README.md`'s ["Worker Nodes (distributed compute)"](../../apps/cli/README.md#worker-nodes-distributed-compute) section for full command reference, flags, and the TUI dashboard's own doctor overlay — this document's job is dependency setup, not day-to-day operation.

---

## 6. Reading `node doctor` Output

The single most important concept in this whole guide: **installed** and **operational** are different claims, and `node doctor` reports both.

- **Installed** (step 2 of the sweep) means the native module resolves via `require.resolve` — the package is present in `node_modules` (or, for `ffmpeg`/`ffprobe`, the binary runs). It proves nothing about whether the library actually works on this machine, or whether its model files have been downloaded.
- **Operational** (step 3, `runOperationalSelfTests()`) means a real minimal operation was attempted and succeeded — `sharp` actually decoded and re-encoded a pixel buffer, the CLIP model actually produced a 512-dimensional embedding, the Human detector actually ran inference on a synthetic image, tesseract actually initialized and tore down a real OCR worker. A capability can be installed but not operational — most commonly because its model file/language data hasn't been fetched yet (§3), or, more rarely, because the installed native binary is broken for this platform.

Job-type readiness (step 4) is gated on the **operational** result, not mere presence — a node whose `sharp` package resolves but crashes on first real use is correctly reported not-ready for every job type that needs it, rather than silently claiming jobs it cannot actually process.

Both the CLI command (`memoriahub node doctor`) and the TUI screen (Tools ▸ Worker Node ▸ Node doctor, and the dashboard's `[r]` quick-doctor overlay) run the identical six-step sweep and share the same classification logic (`apps/cli/src/node/doctor-summary.ts`). The report display is **collapsed by default**: capabilities and job types that are fully healthy (installed AND operational, or ready) are rolled up into a one-line summary count, and only rows with a real issue — not installed, installed-but-not-operational, or not job-ready — are expanded with their full detail message. This means a clean node's doctor output is short; a node with a genuine problem gets the detail surfaced without having to scroll past everything that's already fine.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `tesseract: installed / not yet operational — language data not present` | `tesseract.js`'s trained-data file(s) for the configured language(s) haven't been downloaded/cached yet at `~/.memoriahub/models/tesseract/` — this only happens on real first-use, not proactively | Ensure network access and write permission to `~/.memoriahub/models/tesseract/`, then let a real OCR pass run once (a `social_media_detection` job reaching Tier 2). Until then, `social_media_detection` runs Tier-1-only (degraded, not broken). See §3. |
| A capability shows `no` (not installed) at all | The corresponding `optionalDependencies` entry failed to build/download for this platform — most commonly a missing native compile toolchain | Install the toolchain: `sudo apt install build-essential python3` (Debian/Ubuntu) or `xcode-select --install` (macOS) — the same guidance `apps/cli/README.md` documents for `better-sqlite3` — then reinstall/rebuild (`npm_config_build_from_source=true bash install.sh` if a prebuilt binary genuinely isn't available for this platform/Node version). |
| CLIP model reports "not downloaded yet" even after a `node start`/`node doctor` run that logged it as downloaded | Manifest/consumer path mismatch: the CLIP entry's `targetSubdir: 'models'` makes `ensureModels()` write to `~/.memoriahub/models/models/clip-vit-b32-vision-quantized.onnx`, one level deeper than where `testClip()`/`duplicate-detection.ts` look (`~/.memoriahub/models/clip-vit-b32-vision-quantized.onnx`) — see §4 | Move or copy the downloaded file up one directory to `~/.memoriahub/models/clip-vit-b32-vision-quantized.onnx`. `duplicate_detection` still runs in dHash-only degraded mode in the meantime, so nothing is hard-broken while this is unresolved. |
| `API error 404: Cannot GET /api/nodes/models/manifest` (or any `/api/nodes/*` 404) | Most likely explanation: the connected API server predates the Distributed Nodes feature, or a reverse-proxy path rewrite is stripping/misrouting the `/api` prefix. This is not typically a CLI bug. | Confirm the API server has been updated/redeployed to a version that includes the `/api/nodes/*` routes, and double-check the `serverUrl` in `~/.memoriahub/config.json` points at the correct `/api`-prefixed base. |
| `node status`/`node list` shows the node as "not recognized by server" (a registered node ID the server 404s/403s on) | The node record was deleted or deregistered server-side — e.g. an admin removed it via `DELETE /api/admin/nodes/:id` on the Worker Nodes admin page, or another process ran `node deregister` for it | Run `memoriahub node register` again to create a fresh registration; the old node ID cannot be revived. |
| `node service install` refuses, or reports systemd unavailable (WSL) | WSL distros often don't have a per-user systemd instance running by default (`systemctl --user show-environment` fails) | Enable systemd via `[boot]\nsystemd=true` in `/etc/wsl.conf`, then `wsl --shutdown` from Windows to restart the distro — or skip systemd entirely and use `memoriahub node start --daemon` instead. See [distributed-nodes.md §9.3](distributed-nodes.md#93-worker-daemon-systemd-service-and-tui-attach) and `apps/cli/README.md`'s "Always-on service" section. |
| `node service install` refuses on Windows outright | systemd has no Windows equivalent — `service install` is a no-op there by design, not a bug | Use `memoriahub node start --daemon` instead. |
