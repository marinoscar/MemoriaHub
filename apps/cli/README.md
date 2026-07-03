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
| `sync [folder...] --all` | `--all` / `--dry-run` / `-r, --recursive` / `--concurrency <n>` | Incremental sync of registered or specified folders | Sync ▸ Sync all folders / Sync selected folders |
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
```

Passing folder paths directly to `sync` auto-registers any path not already in the registry. The `-r` flag sets the recursive flag on newly registered folders.

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

### Upload and registration

Files that pass both checks are uploaded via the server's resumable multipart upload API (init → upload parts → complete). After a successful upload the file is registered as a `MediaItem` on the server and its status is set to `uploaded` in the local DB.

### Per-file status lifecycle

Each file row in the `files` table moves through these statuses:

| Status | Meaning |
|--------|---------|
| `queued` | Discovered and waiting to be processed |
| `uploading` | Currently being uploaded (in-progress) |
| `uploaded` | Successfully uploaded and registered |
| `skipped` | Duplicate on server or unchanged since last sync |
| `failed` | Upload failed; `attempt_count` and `last_error` are recorded |

### Retry and attempts cap

When an upload fails, the attempt count is incremented and the error message is stored. On subsequent `sync` or `retry` runs, failed files with `attempt_count < attempts_cap` are automatically re-queued. Files that reach `attempts_cap` are marked blocked and are skipped unless `--force` is passed to `retry`, which resets their count.

### Crash recovery

On startup, any file rows stuck in `uploading` status (from a previous crashed run) are reset to `queued`. This ensures interrupted uploads are automatically retried on the next run.

### Persistence

All state lives in `~/.memoriahub/memoriahub.db`. The `status` command reads from this database — no server connection is needed to check sync status.

---

## Data locations

| Path | Purpose |
|------|---------|
| `~/.memoriahub/config.json` | Server URL and PAT (mode 0600) |
| `~/.memoriahub/memoriahub.db` | SQLite sync state database |
| `~/.memoriahub/manifests/` | Legacy per-folder JSON manifests (preserved, read-only after migration) |
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

- [Phase 05 — CLI Importer](../../docs/plan/phase-05-cli-importer.md)
- [API Reference](../../docs/API.md)
- [Architecture](../../docs/ARCHITECTURE.md)
