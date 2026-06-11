# Phase 05 — CLI Importer

**Roadmap:** [ROADMAP.md](ROADMAP.md)
**Previous Phase:** [Phase 02 — Metadata Extraction](phase-02-metadata-extraction.md)
**Next Phase:** [Phase 09 — Long-Term Enrichment](phase-09-longterm-enrichment.md)
**Status:** Done

**Note (as built):**

- The binary and config directory use lowercase: command `memoriahub`, config at `~/.memoriahub/config.json`, manifests under `~/.memoriahub/manifests/`. The spec used the mixed-case form `~/.memoriaHub`.
- Two server-side endpoints were added to support the CLI:
  - `GET /api/media?contentHash=<sha256>` — dedup filter; returns the existing `MediaItem` if a file with that hash is already stored, so the upload is skipped.
  - `POST /api/storage/objects/:id/upload/part-urls` — mints presigned S3 URLs for arbitrary part numbers. This enables uploads larger than 10 parts (>100 MB at the default 10 MB chunk size) and lifted the web client's earlier >100 MB upload cap as a side effect.
- Distribution is source-based: build with `npm run build` inside `apps/cli` (or `npm run build -w apps/cli` from the repo root), then invoke via `node apps/cli/dist/index.js` or `npm link`. The `dist/` directory is gitignored.

---

## 1. Goal

Ship a standalone Node.js CLI (`memoriaHub`) that lets users import and sync entire folders of photos and videos into MemoriaHub from a computer or external drive. The CLI authenticates via Personal Access Tokens (reusing the existing PAT infrastructure), uses the Phase 01 resumable upload API, and relies on Phase 02 `contentHash` for deduplication so that re-running `sync` on the same folder never creates duplicate records.

---

## 2. Vision Mapping

| Vision Item | Relevant Section in VISION.MD |
|-------------|-------------------------------|
| #8 — CLI for importing and syncing media from a computer | "CLI" |
| #12 — Import from local folders and exported libraries | "Importing From Existing Platforms" (local-folder tier) |

From the vision: _"The CLI is important for users migrating from existing folders, external drives, old backups, or exported collections from other platforms."_ The `sync` command is specifically designed for repeatable, incremental imports without duplication.

---

## 3. What We Reuse

| Existing File | How It Is Reused |
|---------------|-----------------|
| `apps/api/src/pat/` | PAT auth is the sole auth mechanism for the CLI; no OAuth flow in the terminal |
| Phase 01 `POST /api/media` | After each file upload, register the `StorageObject` as a `MediaItem` |
| Phase 01 `GET /api/media` (filter by `contentHash`) | Check if a file with the same hash already exists before uploading |
| Resumable upload API (`POST /api/storage/objects/upload/init`, upload parts, `POST /api/storage/objects/:id/upload/complete`) | Large files are uploaded in chunks; same flow as the web client |
| Phase 02 `MediaItem.contentHash` | Server-side dedup check: `GET /api/media?contentHash=<sha256>` returns existing item if present |

---

## 4. Scope / Deliverables

- New workspace package `apps/cli/` (Node.js + TypeScript, `commander` for argument parsing)
- Built and distributed as a standalone binary via `pkg` or as an npm-published executable
- Commands:
  - `memoriaHub login` — prompts for server URL and PAT; stores credentials in `~/.memoriaHub/config.json`
  - `memoriaHub import <folder>` — one-shot import of all supported files in a folder (non-recursive by default; `--recursive` flag)
  - `memoriaHub sync <folder>` — incremental sync using a local manifest (`~/.memoriaHub/manifests/<hash-of-folder-path>.json`); skips files already confirmed uploaded
  - `memoriaHub status` — shows sync status for configured folders (last run, files uploaded, pending, failed)
- Supported file types: `image/jpeg`, `image/png`, `image/heic`, `image/webp`, `video/mp4`, `video/quicktime`, `video/x-msvideo`
- Deduplication: local SHA-256 computed before upload; server queried with `GET /api/media?contentHash=<hash>`; skips upload if match found
- Progress output: per-file progress bar (using `cli-progress`), summary table at end
- Config file: `~/.memoriaHub/config.json` stores `serverUrl`, `pat` (stored as-is; user responsible for security)
- Manifest file: `~/.memoriaHub/manifests/<folder-hash>.json` tracks `{ filePath, sha256, mediaItemId, uploadedAt }` for each successfully imported file

---

## 5. Data Model Changes

No server-side data model changes. The CLI uses a local JSON manifest file for its own state. The server already stores `MediaItem.contentHash` (Phase 02) which is the dedup key.

**Local manifest shape** (`~/.memoriaHub/manifests/<folder-hash>.json`):

```json
{
  "folderPath": "/Volumes/BackupDrive/Photos/2023",
  "lastSyncAt": "2026-06-10T08:00:00Z",
  "files": {
    "/Volumes/BackupDrive/Photos/2023/IMG_1234.jpg": {
      "sha256": "e3b0c44298fc1c149afb...",
      "mediaItemId": "uuid",
      "uploadedAt": "2026-06-10T08:01:00Z",
      "status": "uploaded"
    }
  }
}
```

---

## 6. API Endpoints

The CLI consumes existing endpoints. No new server-side endpoints are required.

| Endpoint Used | Purpose |
|---------------|---------|
| `GET /api/auth/me` | Verify PAT is valid at `login` and `sync` startup |
| `GET /api/media?contentHash=<sha256>` | Dedup check before uploading |
| `POST /api/storage/objects/upload/init` | Begin resumable upload |
| `PUT <presigned-part-url>` | Upload each part directly to storage provider |
| `POST /api/storage/objects/:id/upload/complete` | Finalize multipart upload |
| `POST /api/media` | Register `StorageObject` as `MediaItem` |

**Note:** Requires Phase 01 `GET /api/media` to support `contentHash` as a filter query parameter. Confirm that filter is implemented in Phase 01 or add it as a targeted enhancement before shipping Phase 05.

---

## 7. Implementation Steps

| Step | Description | Subagent |
|------|-------------|----------|
| 1 | Create `apps/cli/` directory; add `package.json` with `commander`, `cli-progress`, `@types/node`; add `tsconfig.json` extending `tsconfig.base.json`; add build script | `backend-dev` |
| 2 | Implement `memoriaHub login`: prompt for server URL and PAT, call `GET /api/auth/me` to validate, write `~/.memoriaHub/config.json` | `backend-dev` |
| 3 | Implement local SHA-256 computation utility (stream file through `crypto.createHash('sha256')`) | `backend-dev` |
| 4 | Implement resumable upload helper wrapping the init → upload parts → complete flow with configurable chunk size (default 10 MB) and per-part retry | `backend-dev` |
| 5 | Implement `memoriaHub import <folder>`: enumerate supported files, compute SHA-256, check server dedup, upload non-duplicates, register as `MediaItem`, write to manifest | `backend-dev` |
| 6 | Implement `memoriaHub sync <folder>`: load manifest, skip files in manifest with `status: uploaded`, process new and failed files, update manifest | `backend-dev` |
| 7 | Implement `memoriaHub status`: read all manifests; print summary table per folder (total, uploaded, pending, failed) | `backend-dev` |
| 8 | Add `--recursive` flag to `import` and `sync`; add `--dry-run` flag to preview what would be uploaded without uploading | `backend-dev` |
| 9 | Verify Phase 01 `GET /api/media` accepts `contentHash` as a query filter; add it if missing (small `backend-dev` task targeting Phase 01 controller/service) | `backend-dev` |
| 10 | Write unit tests for SHA-256 utility, dedup-check logic, and manifest read/write | `testing-dev` |
| 11 | Write integration test: mock server responses (MSW or `nock`) for dedup check, upload init/complete, and media registration; verify that an already-uploaded file is skipped on the second `sync` run | `testing-dev` |
| 12 | Update `docs/plan/ROADMAP.md` status for Phase 05 | `docs-dev` |

---

## 8. Acceptance Criteria

- `memoriaHub login` stores config and validates the PAT by calling `/api/auth/me`; invalid PAT prints a clear error.
- `memoriaHub import <folder>` uploads all supported-type files; unsupported types are skipped with a warning.
- Re-running `memoriaHub sync <folder>` on the same folder uploads zero files when all files are already registered (dedup via `contentHash`).
- A 500 MB video file uploads successfully in chunks without timeout; the progress bar updates per part.
- `memoriaHub import` with `--dry-run` prints the list of files that would be uploaded and the dedup matches, without actually uploading.
- `memoriaHub status` prints a table showing at least folder path, last sync time, and counts of uploaded/pending/failed files.
- Config is stored in `~/.memoriaHub/config.json`; the CLI does not accept credentials via positional arguments (security).
- `npm run typecheck` passes for `apps/cli`.
- Unit tests pass for SHA-256 utility and manifest logic.

---

## 9. Out of Scope / Deferred

- OAuth / browser-based login from the CLI (PAT only for now)
- Watch mode (continuous folder watching for new files; deferred)
- Import from Google Photos Takeout ZIP (Phase 09 — Takeout metadata mapping)
- Import from Apple Photos library format (Phase 09)
- Remote network folder mounting (users mount the drive themselves; CLI sees it as a local path)
- Windows installer / macOS app bundle (deferred; npm install is the primary distribution)
