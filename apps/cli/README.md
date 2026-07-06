# @memoriahub/cli

Command-line tool for importing and syncing photo/video folders into a MemoriaHub server.

The CLI persists all sync state in a local SQLite database (`~/.memoriahub/memoriahub.db`), maintains a registry of managed folders, supports syncing all or selected folders in one command, tracks per-file upload status with retry and attempts capping, and includes a Claude-Code-style interactive terminal UI built with Ink/React. Every action available through direct commands is also available through the interactive menu.

---

## Install via curl

```bash
curl -fsSL https://raw.githubusercontent.com/marinoscar/MemoriaHub/main/install.sh | bash
```

The installer auto-detects whether a previous installation exists and updates it in place — re-running the same command is safe and idempotent.

### Install from a local clone (offline or for contributors)

If you have already cloned the repository, or prefer to install without curl, point the installer at your local copy:

```bash
# 1. Clone the repository
git clone https://github.com/marinoscar/MemoriaHub.git ~/MemoriaHub

# 2. Run the installer pointing at the local clone
MEMORIAHUB_SRC=~/MemoriaHub bash ~/MemoriaHub/install.sh
```

### Install size and native dependencies

The installed footprint is approximately **~38 MB**, which includes the Ink/React TUI runtime and the native `better-sqlite3` binary.

`better-sqlite3` ships prebuilt binaries for Node 20, 22, 23, 24, 25, 26 on `linux-x64`, `linux-arm64`, and `macOS` (x64 and arm64). Most users will not need a C compiler. The installer probes the native module after installation and prints a clear remediation message if the prebuilt binary is unavailable for your platform or Node version. To force a source build:

```bash
npm_config_build_from_source=true bash install.sh
```

If the probe fails and you need to compile from source:

```bash
# Debian/Ubuntu
sudo apt install build-essential python3

# macOS
xcode-select --install
```

---

## Update

Re-run the same install command at any time to update to the latest version. The installer removes the old `~/.memoriahub/app` directory, rebuilds from source, and redeploys the standalone app. Your sync database and configuration are preserved.

```bash
# curl (recommended)
curl -fsSL https://raw.githubusercontent.com/marinoscar/MemoriaHub/main/install.sh | bash

# Local clone
MEMORIAHUB_SRC=~/MemoriaHub bash ~/MemoriaHub/install.sh
```

---

## Uninstall

```bash
# If piping from curl
curl -fsSL https://raw.githubusercontent.com/marinoscar/MemoriaHub/main/install.sh | bash -s -- --uninstall

# From a local clone
bash ~/MemoriaHub/install.sh --uninstall
```

Removes `~/.memoriahub/app` and the `~/.local/bin/memoriahub` shim. Configuration, sync database, and legacy manifests in `~/.memoriahub/` are not removed.

---

## Requirements

| Dependency | Minimum version | Notes |
|------------|-----------------|-------|
| Node.js    | 20              | Enforced by installer |
| npm        | bundled with Node | Any version that ships with Node 20+ |
| git        | any             | Used for shallow clone |
| curl       | any             | Used by the curl-pipe flow |

---

## What the installer does

1. Clones the repository (or copies `MEMORIAHUB_SRC`) to a temp directory.
2. Runs `npm install -w apps/cli` and `npm run build -w apps/cli` to compile TypeScript.
3. Copies `dist/` and `package.json` to `~/.memoriahub/app/`.
4. Runs `npm install --omit=dev` inside `~/.memoriahub/app/` to install only runtime dependencies.
5. Probes the native `better-sqlite3` module; exits with a remediation message on failure.
6. Writes a shell shim at `~/.local/bin/memoriahub` that executes `node ~/.memoriahub/app/dist/index.js`.
7. Warns if `~/.local/bin` is not on `$PATH`.

### Installer environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORIAHUB_REPO` | `https://github.com/marinoscar/MemoriaHub.git` | Git clone URL |
| `MEMORIAHUB_REF` | `main` | Branch, tag, or commit to install |
| `MEMORIAHUB_HOME` | `~/.memoriahub` | Root directory for app install and config |
| `MEMORIAHUB_BIN_DIR` | `~/.local/bin` | Directory where the `memoriahub` shim is placed |
| `GITHUB_TOKEN` | _(unset)_ | GitHub token injected into the clone URL (for private forks or to avoid rate limits) |
| `MEMORIAHUB_SRC` | _(unset)_ | Local source directory; skips git clone entirely |

### PATH note

If `~/.local/bin` is not in your `$PATH`, add this line to `~/.bashrc` or `~/.zshrc` and reload your shell:

```bash
export PATH="$PATH:$HOME/.local/bin"
```

---

## Two ways to use the CLI

### (a) Interactive menu

Run `memoriahub` with no arguments in a terminal (TTY), or run `memoriahub menu` explicitly, to launch the interactive terminal UI:

```bash
memoriahub
# or
memoriahub menu
```

When run in a non-TTY context (piped output, CI), bare invocation falls back to printing help.

The root menu displays the ASCII banner, your connected server and account, the DB path, and a navigable hierarchical list of actions. Items marked `▸` are submenus:

```
  Login / Change server
  Sync ▸
    Sync all folders
    Sync selected folders
    Retry failed files
  Reports ▸
    Folder overview
    Recent runs
    Storage synced
    Duplicates
  Settings ▸
    Manage folders
    Manage circles
    App settings
    Factory reset (delete all local data)
  Tools ▸
    Job queue monitor
    Backup
  Help
  Quit
```

When not logged in, only Login, Settings ▸ (Factory reset only), Help, and Quit are shown.

Navigate with arrow keys and Enter — selecting a `▸` item descends one level into its submenu. Press `Esc` or `q` to go back one level (not all the way to the root). The ASCII banner and the connected-server/account identity box render only on the root menu; submenus instead show a breadcrumb trail, e.g. `Menu › Sync`. Every item in the menu is the interactive equivalent of a direct CLI command.

The Reports submenu is generated from a shared reports registry (see [`memoriahub reports`](#memoriahub-reports) below), so it grows automatically as new reports are added — no menu wiring is required per report.

### (b) Direct commands

All actions are available as direct subcommands for scripting and automation:

```bash
memoriahub login
memoriahub folders add ~/Pictures
memoriahub sync --all
memoriahub status
memoriahub retry --all
```

---

## Authentication

Before syncing, authenticate with your server:

```bash
memoriahub login
```

### Default: device authorization flow (browser approval)

Running `memoriahub login` without flags initiates the RFC 8628 device authorization flow:

1. The CLI prompts for the server URL (skip the prompt with `--server <url>`).
2. It requests a device code from the server and prints a verification URL and a short user code, for example:

   ```
   Open in your browser: https://memoriahub.example.com/device
   Then enter the code:  ABCD-1234

   (Or open the direct link: https://memoriahub.example.com/device?code=ABCD-1234)
   ```

3. The CLI makes a best-effort attempt to open the URL in your default browser automatically.
4. Sign in with Google and approve the device on the activation page.
5. Once you approve, the CLI receives a **90-day Personal Access Token** and stores it at `~/.memoriahub/config.json` (mode `0600`).

The token is a standard Personal Access Token — it is revocable at any time from the web app under **Settings > Personal Access Tokens**. Re-running `memoriahub login` issues a fresh token.

### Options

| Flag | Description |
|------|-------------|
| `--server <url>` | Supply the server URL directly and skip the interactive prompt |
| `--token <pat>` | Headless / CI fallback: provide an existing PAT created in the web app (no browser required) |

**Headless / CI usage** (`--token`):

```bash
memoriahub login --server https://memoriahub.example.com --token mhpat_xxxxxx
```

Create the PAT manually in the web app under **Settings > Personal Access Tokens**, then pass it here. The CLI validates the token against the server and saves it — no browser is opened.

The CLI validates any token (device-issued or manually supplied) by calling `GET /api/auth/me`. On success, credentials are written to `~/.memoriahub/config.json` with mode `0600`. Credentials are never accepted as positional arguments.

---

## Commands

### Global options

| Flag | Short | Description |
|------|-------|-------------|
| `--no-color` | | Disable colored output; also respects `NO_COLOR` env variable |
| `--version` | `-V` | Print the installed version |

---

### Full command reference

| Command | Flags | Description | Menu equivalent |
|---------|-------|-------------|-----------------|
| `login` | `--server <url>` / `--token <pat>` | Authenticate via browser device-auth flow (default) or with an existing PAT (`--token`, CI/headless) | Login / Change server |
| `folders add <path>` | `-r, --recursive` / `--disabled` | Register a folder in the managed registry | Settings ▸ Manage folders → [a] add |
| `folders list` | `--json` | List all registered folders | Settings ▸ Manage folders |
| `folders remove <id\|path>` | (none) | Remove a folder and cascade-delete its file records | Settings ▸ Manage folders → [d] remove |
| `folders enable <id\|path>` | (none) | Re-enable a disabled folder | Settings ▸ Manage folders → [e] toggle |
| `folders disable <id\|path>` | (none) | Disable a folder (skipped during sync) | Settings ▸ Manage folders → [e] toggle |
| `sync [folder...] --all` | `--all` / `--dry-run` / `-r, --recursive` / `--concurrency <n>` / `--from <date>` / `--to <date>` | Incremental sync of registered or specified folders | Sync ▸ Sync all folders / Sync selected folders |
| `status` | `--runs` / `--json` | Quick per-folder sync status or recent run history; covers the same underlying data as `reports show overview` / `reports show runs`, just with a fixed, non-extensible output shape | Reports ▸ Folder overview / Recent runs |
| `retry` | `--all` / `--folder <id\|path>` / `--force` | Retry failed uploads; `--force` resets files blocked at the attempts cap | Sync ▸ Retry failed files |
| `settings list` | (none) | Print all settings and their current values | Settings ▸ App settings |
| `settings get <key>` | (none) | Get the current value of one setting | Settings ▸ App settings |
| `settings set <key> <value>` | (none) | Set a setting value | Settings ▸ App settings |
| `reports list` | `--json` | List available reports (id, label, description) from the shared reports registry | Reports ▸ |
| `reports show <id>` | `--json` | Run one report (`overview`, `runs`, `storage`, `duplicates`) and print a table (or JSON with `--json`) | Reports ▸ |
| `jobs` (alias `queue`) | `--interval <sec>` / `--once` / `--json` / `--window <days>` | Live job queue dashboard (server load, ETA); requires an Admin PAT with `jobs:read` | Tools ▸ Job queue monitor |
| `backup` | `--circle <id>` / `--all` / `--dest <path>` | Pull media blobs from the server to a local directory; requires an Admin PAT | Tools ▸ Backup |
| `import <folder>` | `-r, --recursive` / `--dry-run` | One-shot import alias for `sync <folder>` (legacy back-compat) | — |
| `menu` | (none) | Launch the interactive terminal UI (requires a TTY) | — |

`circles list` / `circles use <id>` (set the active circle for uploads) are available as direct commands and are reachable interactively via Settings ▸ Manage circles.

---

### `memoriahub login`

```bash
# Default: device authorization flow — opens browser, issues a 90-day token
memoriahub login

# Skip the server URL prompt
memoriahub login --server https://memoriahub.example.com

# CI/headless: use an existing PAT created in the web app (no browser)
memoriahub login --server https://memoriahub.example.com --token mhpat_xxxxxx
```

### `memoriahub folders`

```bash
# Register a folder (flat scan by default)
memoriahub folders add ~/Pictures/Vacation2024

# Register and scan sub-directories
memoriahub folders add ~/Pictures -r

# Register in disabled state (won't be included in --all syncs)
memoriahub folders add ~/Pictures/Archive --disabled

# List all registered folders
memoriahub folders list
memoriahub folders list --json

# Remove a folder by ID or path (cascade-deletes its file records in the DB)
memoriahub folders remove 3
memoriahub folders remove ~/Pictures/Vacation2024

# Enable or disable
memoriahub folders enable 3
memoriahub folders disable ~/Pictures/Archive
```

The `<id|path>` argument accepts either the numeric folder ID (shown in `folders list`) or the folder path.

### `memoriahub sync`

```bash
# Sync all registered enabled folders
memoriahub sync --all

# Sync one or more specific folders (auto-registers if not yet known)
memoriahub sync ~/Pictures/Vacation2024
memoriahub sync ~/Pictures/Vacation2024 ~/Videos/2025

# Sync with recursive sub-directory scan (when auto-registering)
memoriahub sync ~/Pictures -r

# Preview what would be uploaded without uploading anything
memoriahub sync --all --dry-run

# Override the concurrent upload worker count for this run
memoriahub sync --all --concurrency 5

# Restrict the run to files captured in a date range
memoriahub sync ~/Photos --from 2023-01-01 --to 2023-12-31

# Later, sync everything else — files outside the earlier range are not re-processed
memoriahub sync ~/Photos
```

Passing folder paths directly to `sync` auto-registers any path not already in the registry. The `-r` flag sets the recursive flag on newly registered folders.

> **Files missing their date or location?** Drop a [`memoriahub.json`](#metadata-override-memoriahubjson) file into the folder to supply a fallback *date taken* and *GPS location* for any media that lacks them in its own EXIF — the built-in way to date and geotag old scans, screenshots, and videos in bulk. It needs no flag; `sync` picks it up automatically. See [Metadata override (`memoriahub.json`)](#metadata-override-memoriahubjson).

| Flag | Description |
|------|-------------|
| `--from <date>` | Only include files captured on or after this date (`YYYY-MM-DD` or full ISO 8601) |
| `--to <date>` | Only include files captured on or before this date (`YYYY-MM-DD` or full ISO 8601) |

`--from` and `--to` are independent — pass either one alone or both together. Both bounds are **inclusive** and apply to the **start/end of that calendar day in the machine's local timezone** (`--from` = 00:00:00 local, `--to` = 23:59:59.999 local). A file's capture date is resolved using the same source ladder described in [Capture-date inference](#capture-date-inference) (EXIF `DateTimeOriginal` → `CreateDate` → `ModifyDate`, falling back to the oldest filesystem timestamp); a file whose date cannot be determined at all is excluded from a filtered run.

Because out-of-range files are recorded as `skipped` rather than `uploaded` (see [Date range filtering](#date-range-filtering) below), a later unfiltered `memoriahub sync ~/Photos` picks them up and uploads them normally — filtering never permanently excludes a file, and it never causes already-uploaded files to be re-processed.

### `memoriahub status`

```bash
# Per-folder overview: path, last sync, uploaded/pending/failed counts
memoriahub status

# Recent sync run history (last 20 runs)
memoriahub status --runs

# Machine-readable JSON
memoriahub status --json
memoriahub status --runs --json
```

### `memoriahub retry`

```bash
# Retry failed files across all folders (up to the attempts cap)
memoriahub retry --all

# Retry failed files in a specific folder
memoriahub retry --folder 3
memoriahub retry --folder ~/Pictures/Vacation2024

# Also retry files blocked at the attempts cap (resets their attempt count)
memoriahub retry --all --force
```

Without `--all` or `--folder`, `retry` targets all folders containing failed files.

### `memoriahub settings`

```bash
memoriahub settings list
memoriahub settings get concurrency
memoriahub settings set concurrency 5
memoriahub settings set attempts_cap 10
```

| Key | Default | Description |
|-----|---------|-------------|
| `concurrency` | `3` | Max concurrent upload workers per sync run |
| `attempts_cap` | `5` | Max upload attempts per file before it is blocked |
| `max_retries` | `5` | Retry attempts per request on `429`/`503`/`5xx`/network errors |
| `retry_base_ms` | `500` | Base backoff (ms) for request retries (exponential + jitter) |
| `retry_max_ms` | `30000` | Per-attempt backoff cap (ms) |
| `rate_limit_cooldown_ms` | `2000` | Base global cooldown (ms) when a worker is throttled |
| `rate_limit_max_cooldown_ms` | `60000` | Global cooldown ceiling (ms) |

**Rate-limit handling.** Uploads go directly to the storage provider (AWS S3
returns `503 SlowDown`, Cloudflare R2 returns `429`) and to the API. The CLI
retries throttled/transient requests with exponential backoff + jitter,
honoring the server's `Retry-After` header. A single shared cooldown gate makes
all concurrent workers back off together when any one of them is throttled, so a
bulk `sync` won't hammer a rate-limited endpoint. The sync output shows a
`Rate limited — slowing down…` notice while a cooldown window is active.

### `memoriahub reports`

```bash
# List available reports
memoriahub reports list
memoriahub reports list --json

# Run a single report
memoriahub reports show overview
memoriahub reports show runs
memoriahub reports show storage
memoriahub reports show duplicates

# Machine-readable JSON ({id, label, columns, rows, summary})
memoriahub reports show storage --json
```

Reports are defined in a shared registry (`apps/cli/src/reports/`) used by both this headless command and the TUI's `Reports ▸` submenu, so the submenu grows automatically as new reports are registered — no separate menu wiring is needed. An unknown `<id>` prints an error to stderr and exits with code 1.

Built-in reports:

| ID | Label | Description |
|----|-------|-------------|
| `overview` | Folder overview | Same per-folder summary as `memoriahub status` |
| `runs` | Recent runs | Same run history as `memoriahub status --runs` |
| `storage` | Storage synced | Count plus total/average bytes of uploaded media |
| `duplicates` | Duplicates | Files skipped during sync because the server already had identical content (backed by a persisted `skip_reason` column) |

### `memoriahub import <folder>` (legacy alias)

```bash
memoriahub import ~/Pictures/Vacation2024
memoriahub import ~/Pictures/Vacation2024 --recursive
memoriahub import ~/Pictures/Vacation2024 --dry-run
```

`import` is a back-compatibility alias for `sync <folder>`. It registers the folder if not already known and runs a one-shot sync of that folder. Prefer `sync` for new scripts.

---

## How sync works

### Folder registry

Folders are registered once and retained across sessions. `sync --all` targets every enabled folder in the registry. Disabling a folder keeps its history but excludes it from `--all` runs.

### File enumeration

For each target folder the engine enumerates all supported files (see [Supported file types](#supported-file-types)). Each file is upserted into the `files` table with its size and MIME type.

### Deduplication and skip logic

Three checks prevent redundant uploads:

1. **Unchanged-skip (fast path)** — if a file already has status `uploaded` and its size on disk matches the recorded size, the file is skipped without any network call.
2. **Hash cache** — before computing a SHA-256 for a file, the engine checks whether the locally stored hash is still valid. The cache is keyed on `(size_bytes, mtime_ms)`: if both match the recorded values the stored hash is reused, avoiding a full re-read of unchanged files on subsequent runs. The `mtime_ms` column was added to the `files` table to support this cache.
3. **Server content-hash dedup (pre-check)** — for all other queued files, the CLI computes a local SHA-256 and sends `GET /api/media?circleId=<id>&contentHash=<sha256>`. If the server already holds a media item with that hash within the same circle (regardless of filename or folder), the upload is skipped and the file is recorded as `skipped`.

**Server-side dedup backstop:** After a successful upload the CLI sends `contentHash` as part of the `POST /api/media` registration request. The server enforces a partial unique index on `(circle_id, content_hash)` for active items, so if two CLI sessions upload the same file concurrently into the same circle only one `MediaItem` is created. Dedup is scoped to the circle, not the uploading user: two different users uploading the same file into the same circle will be flagged as duplicates, but uploading the same file into two different circles will not be. The server returns `deduplicated: true` on the response when this happens; the CLI records the file as `skipped` (dedup) rather than `uploaded` so the local database accurately reflects that the file is already represented in the library.

### Date range filtering

`sync --from <date>` and `sync --to <date>` (see [`memoriahub sync`](#memoriahub-sync)) restrict a run's work-set to files whose inferred capture date falls in the requested range. Filtering happens before the dedup checks above and only ever narrows which files are *considered* — it never changes how an included file is deduplicated.

Files outside the requested range are recorded as `skipped` with skip reason `out_of_range` ("out of date range" in status output and reports), a new reason alongside the unchanged-skip and server dedup paths above. Critically, out-of-range files are **not** marked `uploaded`, so they are not "used up" by a filtered run: a later `memoriahub sync` with no `--from`/`--to` re-evaluates them from scratch and uploads them normally. Files already uploaded during an earlier filtered run stay protected on subsequent runs the same way any already-uploaded file does — via the unchanged-skip fast path and server-side content-hash dedup. Applying or removing the date filter across runs is therefore always safe: it can only affect which files are considered in a given run, never cause duplicate uploads or permanently exclude a file.

### Upload and registration

Files that pass both checks are uploaded via the server's resumable multipart upload API (init → upload parts → complete). After a successful upload the file is registered as a `MediaItem` on the server and its status is set to `uploaded` in the local DB.

### Capture-date inference

When a file has no EXIF date taken (`DateTimeOriginal` / `CreateDate` / `ModifyDate`), the CLI infers one from the file's filesystem timestamps rather than leaving `capturedAt` unset. The **oldest** of the file's created (birthtime), modified (mtime), and accessed (atime) timestamps is used — copying or moving a file tends to bump some of these to "now", so the oldest surviving stamp is the best available guess at the original capture time. Invalid or unusable timestamps (epoch 0, or values in the future due to clock skew) are ignored; if no usable stamp exists at all, `capturedAt` is left unset.

A genuine EXIF date always takes priority — inference only fills the gap when EXIF has none, and never overrides a real EXIF date even if the server later re-extracts metadata (metadata sync is present-only).

To set an explicit date (and location) yourself instead of relying on the filesystem-timestamp guess, drop a [`memoriahub.json`](#metadata-override-memoriahubjson) file into the folder — an override date takes priority over the timestamp guess while still yielding to a real EXIF date.

This happens automatically during `memoriahub sync` uploads, with no new flags to opt in. Alongside `capturedAt`, the CLI also sends `originalCreatedAt` (the file's creation time) as a provenance field. The offline `scan` preview (see [Scan](#scan-dry-run-preview) below) surfaces the same inferred date, and its Excel/CSV export adds a **Date source** column to the Detail sheet — `EXIF`, `File timestamp`, or blank — so guessed dates are clearly distinguished from real EXIF dates.

### Per-file status lifecycle

Each file row in the `files` table moves through these statuses:

| Status | Meaning |
|--------|---------|
| `queued` | Discovered and waiting to be processed |
| `uploading` | Currently being uploaded (in-progress) |
| `uploaded` | Successfully uploaded and registered |
| `skipped` | Duplicate on server, unchanged since last sync, or outside a `--from`/`--to` date range |
| `failed` | Upload failed; `attempt_count` and `last_error` are recorded |

### Retry and attempts cap

When an upload fails, the attempt count is incremented and the error message is stored. On subsequent `sync` or `retry` runs, failed files with `attempt_count < attempts_cap` are automatically re-queued. Files that reach `attempts_cap` are marked blocked and are skipped unless `--force` is passed to `retry`, which resets their count.

### Crash recovery

On startup, any file rows stuck in `uploading` status (from a previous crashed run) are reset to `queued`. This ensures interrupted uploads are automatically retried on the next run.

### Persistence

All state lives in `~/.memoriahub/memoriahub.db`. The `status` command reads from this database — no server connection is needed to check sync status.

---

## Metadata override (`memoriahub.json`)

> **Drop one `memoriahub.json` into a folder to supply the date and location for media that has none of its own.** This is the built-in way to correctly date and geotag old scans, screenshots, messaging-app exports, and videos in bulk — before they ever reach the server.

### Why this file exists

Photos and videos are only as useful as their metadata. A modern phone photo carries an EXIF *date taken* and GPS coordinates, so the server can place it on your timeline and on the map automatically. But a huge amount of real-world media carries **no embedded metadata at all** — scanned prints, screenshots, files re-shared through messaging apps (which strip EXIF), and most camcorder/older video clips. Without a date those files fall back to a best-guess from the file's timestamps; without coordinates they never appear on the map or in place-based browsing.

`memoriahub.json` closes that gap at the source. Instead of hand-editing every file or cleaning up after the fact, you write **one small, hand-editable file per folder** describing the date and place that folder's media was captured, and the CLI fills in only what each file is missing. It exists so you can organize metadata-less media into folders — a trip, a day, a shoebox of scans — and have that context land correctly in MemoriaHub in a single pass.

### How it behaves

- **Fallback only — a file's own EXIF always wins, per field.** The override never overwrites real metadata; it only fills gaps. A photo with an EXIF date but no GPS keeps its date and takes the location from the file; a photo with GPS but no date keeps its GPS and takes the date. Date and location are decided independently.
- **Videos always receive it.** The CLI reads no EXIF from videos, so a video takes whatever the override supplies — this is the primary way to date and geotag video.
- **Scoped to its own folder.** An override applies only to media **directly inside the folder that contains it** — it does **not** recurse into subfolders. Segregate a trip/day/batch into its own folder and drop one `memoriahub.json` in it; give a subfolder its own file when it needs different values.
- **An invalid file stops the sync.** If a `memoriahub.json` is present but malformed (bad JSON, out-of-range coordinates, unknown version, duplicate file entries), the run **aborts with a clear error naming the file and the problem, and uploads nothing for that folder** — a typo can never silently mis-tag your library. A *missing* file is not an error; that folder simply has no override.
- **Coordinates are reverse-geocoded** by the server into country/region/city, so overridden items show up correctly on the map and in place browsing (recorded with `coordSource: manual`).

### File format

Create a file named exactly `memoriahub.json` (a normal, visible filename) inside the folder:

```json
{
  "version": 1,
  "fallback": {
    "capturedAt": "2019-06-15T14:30:00-06:00",
    "location": { "latitude": 9.9281, "longitude": -84.0907, "altitude": 1170 }
  },
  "files": [
    { "name": "IMG_0042.jpg", "location": { "latitude": 9.63, "longitude": -84.66 } }
  ]
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `version` | yes | Schema version — currently `1`. |
| `fallback.capturedAt` | no | Fallback *date taken*, ISO 8601 with UTC offset (preferred), or a date-only `YYYY-MM-DD` (expanded to local noon). Used only when the file has no EXIF date. |
| `fallback.location.latitude` / `longitude` | together | Fallback GPS coordinates (`latitude` −90…90, `longitude` −180…180). Used only when the file has no EXIF GPS. |
| `fallback.location.altitude` | no | Optional altitude in meters. |
| `files[]` | no | Array of per-file overrides matched by exact filename (`name`), each carrying the same `capturedAt` / `location` fields. A per-file entry beats the folder `fallback` for that one file. |

The file itself is never uploaded as media — the CLI skips it during enumeration.

### Verify before uploading

Preview exactly which files would receive the fallback — with no uploads and no server calls — using a dry run:

```bash
memoriahub sync --dry-run ~/Pictures/CostaRica2019
```

The scan report flags, per file, whether the date and/or location fallback would apply, and surfaces any invalid `memoriahub.json` so you can fix it before committing to an upload.

**Full specification** (schema reference, merge semantics, worked examples): [docs/specs/cli-metadata-override.md](../../docs/specs/cli-metadata-override.md).

---

## Scan (dry-run preview)

`scan` is a fully offline, read-only preview of what a `sync` would do. It enumerates every file in a folder, reads lightweight local metadata (EXIF presence, GPS presence) from each file, and persists an immutable snapshot in the local SQLite database (`~/.memoriahub/memoriahub.db`) — the same file `sync` uses, but in dedicated tables that sync never touches. The result is a dashboard report you can revisit later or export to Excel.

`scan`, `scan list`, `scan report`, and `scan export` are entirely local: no PAT and no server connection are required. Only `sync --scan` talks to the server, because it proceeds to actually reconcile and upload.

Running or viewing a scan from the interactive menu (**Scan ▸ Scan all folders / Scan selected folders / View last scan report** in `memoriahub menu`) also auto-creates an Excel workbook at `~/.memoriahub/exports/scan-<id>.xlsx` and prints its absolute path afterward; the file is overwritten on re-view (one per scan ID, no duplicates) and a failed export only shows a warning rather than blocking the report from rendering. (The headless `scan` command does not auto-export — use `scan export <id> --out <file>` for that.)

Full details — data model, metadata scope, and the reconciliation algorithm — are in [docs/specs/cli-scan.md](../../docs/specs/cli-scan.md).

### Supported media formats

`scan` and `sync` discover files by extension only (case-insensitive) — there's no content sniffing. Coverage is broad: common raster images (JPEG, PNG, GIF, BMP, WebP, TIFF), modern formats (HEIC/HEIF, AVIF, JPEG 2000, JPEG XL), a wide range of camera RAW formats (DNG, CR2/CR3, NEF, ARW, ORF, RW2, RAF, and more), modern video containers (MP4, WebM, MKV), and legacy/camcorder/broadcast video formats (AVI, MOV, MPEG/MPG, VOB, WMV, 3GP, MTS/M2TS, FLV). See [Supported Formats](../../docs/specs/cli-scan.md#supported-formats) in the Scan spec for the full extension list.

### `memoriahub scan`

```bash
# Scan all registered folders and show the dashboard/report
memoriahub scan --all

# Scan a specific folder (auto-registers if not yet known, same as sync)
memoriahub scan ~/Pictures/Vacation2024

# Recursive scan when auto-registering
memoriahub scan ~/Pictures -r

# Machine-readable JSON instead of the dashboard/tables
memoriahub scan --all --json

# Persist the scan without rendering a report
memoriahub scan --all --no-report

# Override the concurrent file-read worker count for this run
memoriahub scan --all --concurrency 5
```

Rendering adapts to context automatically: an Ink dashboard on a TTY, plain tables when piped, or JSON with `--json`.

### `memoriahub scan list`

```bash
memoriahub scan list
memoriahub scan list --json
```

Lists recent scan runs, most recent first.

### `memoriahub scan report`

```bash
# Re-render the most recent scan
memoriahub scan report

# Re-render a specific scan by ID
memoriahub scan report 12
memoriahub scan report 12 --json
```

Re-renders a previously stored scan without touching the filesystem again.

### `memoriahub scan export`

```bash
# Excel workbook: Summary sheet (KPIs/coverage/breakdowns) + Detail sheet (one row per file)
memoriahub scan export 12 --out scan-report.xlsx

# Flat CSV instead
memoriahub scan export 12 --out scan-report.csv
```

The export format is inferred from the `--out` file extension (`--format xlsx|csv` overrides this).

The Detail sheet includes a **Date source** column (`EXIF`, `File timestamp`, or blank) showing whether each file's date came from real EXIF metadata or was inferred from filesystem timestamps — see [Capture-date inference](#capture-date-inference).

### `memoriahub sync --scan`

```bash
# Reconcile against a specific scan before syncing
memoriahub sync ~/Pictures/Vacation2024 --scan 12

# Reconcile against the most recently stored scan
memoriahub sync --all --scan latest
```

Compares the live folder state against the scan snapshot (by file size + modified time, not content hashing) and prints a "changes since scan" panel showing added/removed/modified/unchanged counts before proceeding with the upload. A `sync` run without `--scan` behaves exactly as before — no reconciliation.

### Example flow

```bash
# 1. Preview a folder before committing to a long upload
memoriahub scan ~/Pictures/Vacation2024

# 2. Review the report again later (e.g. scan ID 12 from step 1)
memoriahub scan report 12

# 3. Export it to Excel for offline review
memoriahub scan export 12 --out vacation2024-scan.xlsx

# 4. Sync, reconciling against the scan to see what changed since
memoriahub sync ~/Pictures/Vacation2024 --scan 12
```

---

## Organize (reorganize by date before syncing)

`organize` is a fully offline, local-only command that reorganizes a folder's media into date-based subfolders before you ever run `sync` — so the on-server layout starts clean instead of mirroring whatever ad-hoc folder structure the files happened to be in.

`organize` is entirely local: no PAT and no server connection are required, the same as `scan`.

### `memoriahub organize`

```bash
memoriahub organize [folder...] [--all] [--dry-run] [-r|--recursive] [--concurrency <n>] [--json]
```

```bash
# Preview the plan for a folder without moving anything
memoriahub organize ~/Photos --dry-run

# Organize a specific folder
memoriahub organize ~/Photos

# Organize every registered enabled folder
memoriahub organize --all

# Recurse into sub-directories of an ad-hoc (not-yet-registered) path
memoriahub organize ~/Photos -r

# Override the concurrent metadata-read worker count
memoriahub organize ~/Photos --concurrency 5

# Machine-readable totals instead of the summary box
memoriahub organize ~/Photos --json
```

| Flag | Description |
|------|-------------|
| `[folder...]` | One or more folder paths to organize; unknown paths are auto-registered, same as `scan`/`sync`. Omit and pass `--all` instead to organize every registered enabled folder. |
| `--all` | Organize every registered enabled folder instead of specific paths. |
| `--dry-run` | Preview the plan (what would move, and what would go to `NODATE/`) without moving anything. |
| `-r`, `--recursive` | Descend into sub-directories when organizing an ad-hoc (not-yet-registered) path. |
| `--concurrency <n>` | Number of concurrent metadata-read workers. |
| `--json` | Emit the totals object (`{ total, moved, skipped, conflicts, errors, nodate, byBucket }`) instead of the summary box. |

### Example flow

```bash
memoriahub organize ~/Photos --dry-run
memoriahub organize ~/Photos
```

The first run previews exactly what would move; the second actually performs the moves.

### Resulting layout

`organize` walks the folder for media files using the same extension-based, case-insensitive discovery mechanism as `scan`/`sync` (see [Supported media formats](#supported-media-formats)). For each file it reads the photo's EXIF capture date — from the **full file**, not just the header, so a date located deep in the file is never missed — and moves the file into a `YEAR/MM - Month/` subfolder created inside that same folder, e.g.:

```
Photos/
  2023/
    07 - July/
      IMG_0001.jpg
  2024/
    01 - January/
      IMG_0042.jpg
  NODATE/
    clip.mp4
```

Files with no EXIF capture date are moved into a top-level `NODATE/` folder instead. **This currently includes every video** — the CLI does not probe video metadata for a capture date, so all video files land in `NODATE/` regardless of any date embedded in the container. This EXIF-only date read is specific to `organize`; unlike sync's [capture-date inference](#capture-date-inference), `organize` does not fall back to filesystem timestamps when EXIF is absent.

`organize` is idempotent: files already sitting in their correct `YEAR/MM - Month/` (or `NODATE/`) bucket are skipped, so re-running the command after it has already organized a folder moves nothing. It is also non-destructive to data — if a move would collide with an existing file of different content at the destination, the CLI appends ` (1)`, ` (2)`, … to the filename rather than overwriting anything. Moves are cross-device safe: if a direct rename fails with `EXDEV` (source and destination are on different filesystems/mount points), the CLI falls back to a copy-then-delete.

### Interactive UI

`organize` is also reachable from the interactive menu under **Settings ▸ Organize folder by date**. It runs a plan → confirm → execute flow: it first computes and shows the full plan (what would move, what would go to `NODATE/`), asks for a `y` confirmation before touching anything (since it moves files), and then executes with a live progress bar.

---

## Convert (transcode videos to MP4)

`convert` is a fully offline, local-only command that transcodes video files to `.mp4` — turning legacy or awkward formats (MOV from iPhones, MTS/M2TS from AVCHD camcorders, AVI, WMV, and more) into the broadly-compatible MP4 container so they play everywhere and behave well downstream. Like `scan`/`organize`, it needs no PAT and no server connection.

> **Requires [ffmpeg](https://ffmpeg.org/).** `convert` shells out to `ffmpeg`, which must be installed and on your `PATH`. It is not bundled. If it is missing, the command exits with a per-platform install hint:
> - macOS: `brew install ffmpeg`
> - Debian/Ubuntu: `sudo apt install ffmpeg`
> - Windows: `winget install ffmpeg` (or `choco install ffmpeg`)

### `memoriahub convert`

```bash
memoriahub convert [path...] [--all] [--dry-run] [-r|--recursive] [--concurrency <n>] \
                   [--formats <list>] [--delete-original] [--overwrite] [--reencode] [--crf <n>] [--json]
```

```bash
# Convert a single video file
memoriahub convert ~/Videos/holiday.MOV

# Convert every video in a folder (files land as .mp4 alongside the originals)
memoriahub convert ~/Videos

# Preview what would be converted without running ffmpeg
memoriahub convert ~/Videos --dry-run

# Convert videos in every registered enabled folder
memoriahub convert --all

# Only convert certain formats
memoriahub convert ~/Videos --formats mov,mts

# Delete each original after its .mp4 is written and verified
memoriahub convert ~/Videos --delete-original

# Force a full re-encode (instead of the lossless remux fast-path) at a chosen quality
memoriahub convert ~/Videos --reencode --crf 22
```

| Flag | Description |
|------|-------------|
| `[path...]` | One or more video **files** and/or **folders**. Files are converted directly; folders are walked for convertible videos (unknown folder paths are auto-registered, same as `scan`/`organize`). Omit and pass `--all` to sweep every registered enabled folder. |
| `--all` | Convert videos in every registered enabled folder instead of specific paths. |
| `--dry-run` | Preview how many files would be converted without running ffmpeg. |
| `-r`, `--recursive` | Descend into sub-directories when auto-registering an ad-hoc folder path. |
| `--concurrency <n>` | Number of concurrent conversions. |
| `--formats <list>` | Comma-separated extensions to convert (e.g. `mov,mts`). Default: all recognized non-MP4 videos. |
| `--delete-original` | Delete each source file after its `.mp4` is verified written. Off by default (originals are kept). |
| `--overwrite` | Overwrite an existing target `.mp4` instead of skipping it. |
| `--reencode` | Force a full H.264 re-encode, skipping the lossless remux fast-path. |
| `--crf <n>` | Quality for the re-encode path (lower = better quality/larger file; default 20). |
| `--json` | Emit the totals object (`{ total, converted, skipped, errors, deleted, remuxed, reencoded, bytesIn, bytesOut }`) instead of the summary box. |

### What gets converted

`convert` walks folders using the same extension-based, case-insensitive discovery as `scan`/`sync` (see [Supported media formats](#supported-media-formats)) and picks every file whose type is a video **except those already in an MP4 container** (`.mp4`, `.m4v`). That covers MOV, QT, MTS, M2TS, AVI, WMV, ASF, MKV, WEBM, FLV, 3GP, MPEG, VOB, DIVX, and the rest of the recognized video set. Photos are never touched. Use `--formats` to narrow the set.

### How each file is converted

For every source, `convert` first attempts a **lossless remux**: it copies the (usually H.264) video stream untouched and transcodes only the audio to AAC — instant, no visible quality loss — writing `name.mp4` next to the original. If that fails because the source codec isn't MP4-compatible (e.g. ProRes, or an exotic AVI codec), it automatically falls back to a full **H.264 re-encode**. Pass `--reencode` to force the re-encode path for every file, and `--crf` to tune its quality.

Conversions are written to a temporary `.partial` file and renamed into place only on success, so an interrupted run never leaves a truncated `.mp4`. `convert` is idempotent — if the target already exists it is skipped (`--overwrite` to replace) — and non-destructive by default: originals are kept unless you pass `--delete-original`, and name collisions append ` (1)`, ` (2)`, … rather than overwriting.

### Interactive UI

`convert` is also reachable from the interactive menu under **Convert videos to MP4 ▸**, which offers three modes:

- **Convert a single file** — type/paste a path to one video file.
- **Convert selected folder(s)** — pick from your registered folders.
- **Convert all registered folders** — sweep everything.

Each mode runs a plan → confirm → execute flow: it counts the convertible files, asks for a `y` confirmation (since it creates files and, with `--delete-original`, removes originals), then converts with a live progress indicator. If ffmpeg is not installed, the screen shows the error with the install hint.

---

## Data locations

| Path | Purpose |
|------|---------|
| `~/.memoriahub/config.json` | Server URL and PAT (mode 0600) |
| `~/.memoriahub/memoriahub.db` | SQLite sync state database |
| `~/.memoriahub/manifests/` | Legacy per-folder JSON manifests (preserved, read-only after migration) |
| `~/.memoriahub/exports/` | Auto-exported Excel workbooks: `scan-<id>.xlsx` per scan (see [Scan](#scan-dry-run-preview)) and `sync-<runId>.xlsx` per completed sync run (see [After sync](#after-sync)) |
| `~/.memoriahub/app/` | Installed CLI app (dist + node_modules) |
| `~/.local/bin/memoriahub` | Shell shim |

---

## Migration note for existing users

On the first run after upgrading to this version, the CLI automatically imports any existing JSON manifests from `~/.memoriahub/manifests/` into the SQLite database. This operation is:

- **Idempotent** — guarded by a settings flag; safe to run multiple times
- **Non-destructive** — manifest files are preserved as read-only historical records; nothing is deleted
- **Atomic** — runs inside a single SQLite transaction

File statuses are mapped as follows: `uploaded` → `uploaded`, `failed` → `failed`, `pending` → `queued`.

After migration, use `memoriahub status` and `memoriahub folders list` to confirm your folders and file records imported correctly.

---

## Interactive UI

### Overview

Running `memoriahub` in a TTY (or `memoriahub menu`) launches a full-screen terminal UI built with Ink (React for the terminal). Every screen is navigable with the keyboard; no mouse required.

Menu navigation is hierarchical, backed by a navigation stack: pressing Enter on a `▸` submenu item pushes onto the stack, and `Esc`/`q` pops one level rather than jumping back to the root menu. The screens documented below (sync dashboard, folder picker, folder manager) are unchanged by this restructuring — only how you reach them from the menu has changed.

### Sync dashboard layout

When a sync is in progress, the dashboard renders the following panels:

```
╭──────────────────────────────────────────────────────────────────╮
│ memoriahub.example.com  |  2 folders  |  syncing…                │
╰──────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────╮
│ Progress                                                          │
│ ████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░        │
│ 52% complete  312 uploaded  4 uploading  280 queued  0 failed     │
│ [uploaded] [uploading] [queued] [skipped] [failed]               │
╰──────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────╮
│ Active uploads (4)                                                │
│ ████████████░░░░░░░░  61%  IMG_4521.jpg                           │
│ ██████░░░░░░░░░░░░░░  32%  IMG_4522.heic                          │
│ ██████████████░░░░░░  71%  VID_0023.mp4                           │
│ ██░░░░░░░░░░░░░░░░░░  11%  IMG_4523.png                           │
╰──────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────╮
│ Recent events                                                     │
│ ✔ IMG_4510.jpg  uploaded                                          │
│ ✔ IMG_4511.heic  uploaded                                         │
│ - IMG_4512.jpg  skipped (unchanged)                               │
│ ✖ IMG_4513.mov  failed (network timeout) — will retry             │
╰──────────────────────────────────────────────────────────────────╯

[q/Esc] cancel and return to home
```

### Progress meter

The progress meter is a 56-character block-grid bar (similar to the `/context` meter in Claude Code) that allocates colored cells proportionally across five categories: `uploaded`, `uploading`, `queued`, `skipped`, and `failed`. Cell allocation uses the largest-remainder (Hamilton/Hare) method so the total always exactly fills the bar. Re-renders are throttled to approximately 10 fps.

### Folder picker

"Sync selected folders" opens a checkbox picker. Use `Space` to toggle folders, `a`/`n` to select/deselect all, and `Enter` to start the sync with the checked folders.

### Date range filter

Both **Sync all folders** and **Sync selected folders** proceed to a "Date range filter" step before the sync starts. Enter optional From/To dates (`YYYY-MM-DD`); a live preview line updates as you type — `Syncing: all dates` when both fields are blank, or `Syncing: 2023-01-01 -> 2023-12-31` once a bound is set. Leaving both blank syncs all dates, matching the headless default. The [sync dashboard](#sync-dashboard-layout) shows the active range in its header while the run is in progress.

### Folder manager

"Manage folders" opens an interactive table. Keys:

| Key | Action |
|-----|--------|
| `a` | Add a new folder (prompts for path and recursive flag) |
| `e` | Toggle enable/disable on the selected folder |
| `d` | Remove the selected folder (with confirmation) |
| Up/Down | Navigate rows |
| `q` / Esc | Return to home menu |

### After sync

When a run completes, the dashboard transitions to a summary screen showing uploaded, skipped, and failed counts, the run duration, and a list of any failed files. From the summary you can return to the home menu to retry.

Every completed sync run also auto-creates an Excel workbook at `~/.memoriahub/exports/sync-<runId>.xlsx` and prints its absolute path — from both the interactive dashboard summary and the headless `memoriahub sync` command. The workbook has two sheets: a **Summary** sheet (run metadata — run ID, trigger, dry-run flag, start/finish timestamps as real dates, duration, and totals with uploaded size in MB) and a **Detail** sheet (one row per processed file: path, status, detail/reason, size in MB, MIME type, media kind, media item ID, and SHA-256 prefix). Sizes are formatted in MB with two decimals and timestamps are stored as real spreadsheet dates. A failed export only shows a warning; it never blocks the run from completing.

---

## Supported file types

| Extension | MIME type |
|-----------|-----------|
| jpg, jpeg | image/jpeg |
| png | image/png |
| heic | image/heic |
| webp | image/webp |
| mp4 | video/mp4 |
| mov | video/quicktime |
| avi | video/x-msvideo |

Files with other extensions are skipped.

---

## Large file uploads

Files are uploaded using the server's resumable multipart upload API (init → upload parts → complete). The default chunk size is 10 MB. There is no cap on the number of parts, so files larger than 500 MB are handled correctly.

---

## Manual / from-source build (contributors)

Dependencies and the build step must be run from the repo root (npm workspaces):

```bash
# Install workspace dependencies
npm install

# Compile the CLI
npm run build -w apps/cli
```

The compiled output lands in `apps/cli/dist/` (gitignored). After building, invoke the CLI directly:

```bash
node apps/cli/dist/index.js <command>
```

The binary name registered in `package.json` is `memoriahub`.

---

## Related documentation

- [Metadata override (`memoriahub.json`) specification](../../docs/specs/cli-metadata-override.md)
- [Phase 05 — CLI Importer](../../docs/plan/phase-05-cli-importer.md)
- [API Reference](../../docs/API.md)
- [Architecture](../../docs/ARCHITECTURE.md)
