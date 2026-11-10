# @marinoscar/memoriahub-compute

Pure enrichment compute for MemoriaHub: image preparation, CLIP embeddings, perceptual hashes, EXIF and video metadata, CompreFace and OCR helpers, the social-media rule engine and the result contracts of the node-eligible job types. Dual CommonJS and ESM. It imports no framework and no `@marinoscar/platform-*` package, so the API and a worker node install the same code.

## Purpose and scope

The package is the parity layer of the distributed worker design: the compute half of a node-eligible job runs on the server or on a worker node through the same functions, so a vector or a hash computed on a node is numerically identical to one computed on the server for the same bytes. The persist half of a job stays in the API. It holds no service, no controller, no database access and no environment read: model paths, base URLs, timeouts and thresholds are parameters of each call. It makes no model call to an AI provider: AI jobs are server-only and run through the platform's AI layer, so no provider SDK and no provider key can reach a node through this package.

Status: experimental. The package was `packages/enrichment-compute` (`@memoriahub/enrichment-compute`, internal) until RETRO-J1 (marinoscar/MemoriaHub#593); the subpaths kept their names, except `./ai`, which was removed. It is `"private": true` until the owner opens the publish gate ([release runbook](../../docs/runbooks/release-memoriahub-packages.md)).

Entry points (a slice README per folder):

- `@marinoscar/memoriahub-compute`: the package root; re-exports every slice below.
- `@marinoscar/memoriahub-compute/image`: image preparation, orientation edits and the HEIC fallback ([slice README](src/image/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-compute/clip`: CLIP ViT-B/32 embeddings ([slice README](src/clip/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-compute/dhash`: perceptual hash and sharpness ([slice README](src/dhash/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-compute/ffmpeg`: the ffmpeg and ffprobe wrapper ([slice README](src/ffmpeg/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-compute/video`: frame sampling and the audio lead ([slice README](src/video/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-compute/metadata`: EXIF, dimensions and container metadata ([slice README](src/metadata/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-compute/geo`: reverse-geocoding response mapping ([slice README](src/geo/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-compute/rate-limit`: the provider rate-limit signal ([slice README](src/rate-limit/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-compute/face-compreface`: CompreFace face detection ([slice README](src/face-compreface/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-compute/face-video`: video face clustering and crops ([slice README](src/face-video/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-compute/ocr`: the Tesseract OCR core ([slice README](src/ocr/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-compute/social`: the social-media rule engine ([slice README](src/social/README.md#purpose-and-scope)).
- `@marinoscar/memoriahub-compute/dto`: the node result schemas ([slice README](src/dto/README.md#purpose-and-scope)).

## Install and peer dependencies

```bash
npm install @marinoscar/memoriahub-compute@next
```

There are no peer dependencies. The native libraries are exact-pinned dependencies, not peers, so that the server and a node run byte-identical builds:

| Package | Version | Needed by |
|---|---|---|
| `sharp` | `0.35.3` | `image`, `dhash`, `clip`, `face-video`, `ocr` |
| `onnxruntime-node` | `1.27.0` | `clip` |
| `exifr` | `7.1.3` | `metadata` |
| `zod` | `^4.4.3` | `dto` |
| `tesseract.js` | `7.0.0` (optional) | `ocr` |

An app that installs the package repeats the three exact pins in its root `overrides` (the repository root `package.json` does), or npm nests a second copy and the parity guarantee is lost. HEIC decode needs `sharp` built against a system libvips with HEIF support (`SHARP_FORCE_GLOBAL_LIBVIPS=1`, as both Dockerfiles do); without it the ffmpeg fallback in `image` decodes the file. The `ffmpeg` and `ffprobe` binaries must be on `PATH` for the `ffmpeg`, `video` and `metadata` slices. The per-slice data is `packages/memoriahub-slice-peers.json`; `node scripts/memoriahub-packages/check-slice-peers.mjs --table` prints it.

## Quick start

```ts
import { prepareImageForProcessing } from '@marinoscar/memoriahub-compute/image';
import { computeVisualHash, hammingDistance } from '@marinoscar/memoriahub-compute/dhash';
// CommonJS: const { computeVisualHash } = require('@marinoscar/memoriahub-compute/dhash');

const hash = await computeVisualHash(bytes);
if (hash) console.log(hash.perceptualHash, hash.sharpnessScore);
```

Keep the `.js` extension on every relative import inside the package; the ESM build fails at run time without it. A consumer compiled with `moduleResolution: node` resolves the subpaths through the per-folder `package.json` stubs the package ships.

## Configuration

None. The package reads no environment variable and takes no option object at start-up. A host may call `setComputeLogger({ warn, error })` once to route the package's warnings and errors to its own logger; until then they are silent.

## Extension-point catalog

None. The package exposes functions and data shapes, not extension points.

## Data

None. It stores nothing. The `dto` slice describes the result a node submits for each job type; the database side is the API's.

## Permissions and settings

None. Permission strings and settings stay where the API enforces them.

## UI

None. The package has no UI.

## Infra

None. The package ships no deployment configuration. An image that installs it must build it (`npm run build -w @marinoscar/memoriahub-compute`) because `.dockerignore` drops every `dist/`; the API and worker Dockerfiles do, and they copy `scripts/memoriahub-packages/` because the build runs its `write-dist-stubs.mjs`.

## Observability

None inside the package: it imports no OpenTelemetry API. The host wraps calls in its own spans and gives the package a logger with `setComputeLogger`.

## Security notes

The package carries no secret and holds no provider key: it has no AI provider call, and `openai` and `@anthropic-ai/sdk` are not dependencies. The geo helpers take a per-job credential as an argument and never store it. Every native dependency is exact-pinned for supply-chain parity between the server and a node. Importing `@marinoscar/platform-*` from this package is a violation (rule 6 of `check:memoriahub-slice-peers`).

## Conformance suite

The package's own `node --test` suite (`npm run test:run -w @marinoscar/memoriahub-compute`): the golden-vector parity test (`test/golden.test.mjs`: a bit-exact dHash and a CLIP vector within 1e-4), the HEIC decode test (`test/heic.test.mjs`) and the ffmpeg argv pins. CI enforces `REQUIRE_HEIC_DECODE=1` in both container images (`.github/workflows/deploy.yml`).

## Upgrade notes

The package was renamed from `@memoriahub/enrichment-compute` and its `./ai` subpath was removed (the video tagging prompt now lives in `apps/api/src/tagging/video-tagging-prompt.ts`). Every import path changed by the scope and name only; the other subpath names are unchanged.

## Troubleshooting

`ERR_MODULE_NOT_FOUND` from an ESM import of a relative path means the `.js` extension is missing in the source. `Cannot find module '@marinoscar/memoriahub-compute/...'` means the package was not built: run `npm run build -w @marinoscar/memoriahub-compute` (CI and the Dockerfiles do it after the install). `TS1479` from a CommonJS consumer means the `dist/cjs/package.json` stub is absent (the build writes it). A golden-vector mismatch after a dependency bump means `sharp` or `onnxruntime-node` changed numerically: do not widen the pins.

## Links

- [Package documentation standard and checks](../../docs/PACKAGES.md): how this README, the TSDoc and the catalog are checked
- [Release runbook](../../docs/runbooks/release-memoriahub-packages.md): versions, the publish gate, rollback
- [ADR 0001: packages first](../../docs/decisions/0001-packages-first.md)
- [Distributed nodes spec](../../docs/specs/distributed-nodes.md): section 7, the parity constraint
