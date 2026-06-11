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

---

## Phase 05.1 — Folder-managed SQLite sync + interactive TUI (as built)

**Status:** Done

This section documents the major upgrade to the CLI delivered after the initial Phase 05 implementation. It replaces the per-folder JSON manifest system with a durable SQLite database, adds a managed folder registry, multi-folder sync, retry/issue tracking, and a Claude-Code-style interactive terminal UI.

### SQLite persistence

All sync state is stored in `~/.memoriahub/memoriahub.db` (a `better-sqlite3` database). The schema consists of four tables:

| Table | Purpose |
|-------|---------|
| `folders` | Folder registry: path, recursive flag, enabled flag, last_sync_at |
| `files` | Per-file state: status, sha256, attempt_count, last_error, media_item_id, size_bytes |
| `sync_runs` | Run history: trigger, folder IDs, total/uploaded/skipped/failed counts, duration, dry_run flag |
| `settings` | Key-value store for CLI settings (concurrency, attempts_cap) |

File status values: `queued`, `uploading`, `uploaded`, `skipped`, `failed`.

The database is created and migrated automatically on first run. All operations use synchronous `better-sqlite3` calls so there is no async database layer.

### Folder registry

Folders are registered once with `memoriahub folders add <path>` (or auto-registered when a path is passed directly to `sync`). Each folder has:
- A numeric ID used to reference it in commands
- A `recursive` flag controlling whether subdirectories are scanned
- An `enabled` flag; disabled folders are excluded from `sync --all` runs
- A `last_sync_at` timestamp updated after each successful run

Subcommands: `folders add`, `folders list`, `folders remove`, `folders enable`, `folders disable`. All accept an `<id|path>` argument.

### Sync engine: all and selected

`memoriahub sync` accepts:
- `--all` — sync all registered enabled folders
- One or more folder paths — sync specific folders (auto-registering any not yet known)
- `--dry-run` — enumerate and hash files, perform dedup checks, but do not upload or persist `uploaded` status
- `--concurrency <n>` — override the concurrent worker count for this run
- `-r, --recursive` — set the recursive flag on auto-registered folders

The engine emits typed events (`run:start`, `run:progress`, `file:start`, `file:progress`, `file:done`, `file:skipped`, `file:failed`, `run:done`, `error`) consumed by either the headless renderer (direct command mode) or the Ink TUI renderer (interactive mode).

### Deduplication

Two layers prevent redundant uploads:
1. **Unchanged-skip** — if a file is already `uploaded` and its size on disk matches the recorded size, it is skipped with no network call.
2. **Server content-hash dedup** — for all other files, SHA-256 is computed locally and checked against `GET /api/media?contentHash=<sha256>`. A match skips the upload.

### Retry and attempts cap

Each file row records `attempt_count` and `last_error`. Failed files with `attempt_count < attempts_cap` are automatically re-queued on the next sync run. Files that reach `attempts_cap` are blocked until `retry --force` is used, which resets their count.

`memoriahub retry` options:
- `--all` — retry failed files across all folders
- `--folder <id|path>` — limit to a specific folder
- `--force` — also reset and retry blocked files

### Crash recovery

On startup, files stuck in the `uploading` state from a previous crashed run are reset to `queued`. This means any interrupted uploads are retried automatically on the next invocation.

### Interactive Ink TUI

Running `memoriahub` with no arguments in a TTY, or `memoriahub menu`, launches a full-screen Ink (React-for-terminal) application. Ink/React components are loaded lazily via dynamic `import()` so the TUI runtime is never loaded in headless code paths.

**Home menu** presents a navigable list (arrow keys + Enter):
- Login / Change server
- Manage folders
- Sync all folders
- Sync selected folders
- Status
- Retry failed files
- Settings
- Help / Quit

When not logged in, only Login, Help, and Quit are shown.

**Sync dashboard** renders while a sync run is in progress:
- `StatusLine` — server host, folder count, elapsed time
- `ContextMeter` — a 56-character block-grid progress bar (Claude-Code `/context` style) using the largest-remainder cell allocation method across five categories (uploaded, uploading, queued, skipped, failed); re-renders throttled to ~10 fps
- `Legend` — counts per category with color coding
- `ActiveUploads` — per-file mini progress bars (up to 5 visible) showing filename and percentage
- `EventLog` — rolling log of completed, skipped, and failed files
- On `run:done`, transitions to a `Summary` screen with final stats and any failure details

**FolderManager** — interactive table with keyboard controls to add (`a`), toggle enable/disable (`e`), remove (`d`), and navigate folders.

**PickFolders** — checkbox multi-select for "Sync selected folders" with Space to toggle, `a`/`n` for all/none, Enter to confirm.

### Command and menu parity

Every CLI command has a direct menu equivalent. The same `SyncEngine` instance is used in both modes; only the renderer differs (headless vs. Ink).

### Legacy manifest auto-import

On the first run after upgrade, the CLI automatically imports all existing JSON manifests from `~/.memoriahub/manifests/` into the SQLite database. The import is idempotent (guarded by a `schema_imported_manifests` settings flag), atomic (single SQLite transaction), and non-destructive (manifests are preserved as read-only records). Legacy status values are mapped: `uploaded` → `uploaded`, `failed` → `failed`, `pending` → `queued`.
