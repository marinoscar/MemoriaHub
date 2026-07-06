# Changelog — @memoriahub/cli

All notable changes to the CLI package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- **Convert videos to MP4** — the new `memoriahub convert [path...] [--all] [--dry-run] [-r|--recursive] [--concurrency <n>] [--formats <list>] [--delete-original] [--overwrite] [--reencode] [--crf <n>] [--json]` command transcodes video files to `.mp4` alongside the originals. Positional arguments may be individual video **files** (converted directly) or **folders** (every recognized non-MP4 video inside is converted); `--all` sweeps all registered folders. It converts the full recognized video set — MOV, MTS, M2TS, AVI, WMV, MKV, FLV, 3GP, MPEG, and more — skipping files already in an MP4 container (`.mp4`/`.m4v`); narrow the set with `--formats mov,mts`. Each file is remuxed losslessly when possible (copy the H.264 video stream, transcode audio to AAC — instant, no quality loss) and only falls back to a full H.264 re-encode when the source codec isn't MP4-compatible; `--reencode` forces the full re-encode and `--crf` tunes its quality. Originals are kept by default (`--delete-original` removes each source after its `.mp4` is verified), existing targets are skipped for idempotent re-runs (`--overwrite` to replace), and name collisions append ` (1)`, ` (2)`, …. **Requires [ffmpeg](https://ffmpeg.org/) on your PATH** — when missing, the command exits with an install hint (`brew install ffmpeg` / `apt install ffmpeg` / `winget install ffmpeg`). Also reachable from the interactive menu under `Convert videos to MP4 ▸`, offering three modes — convert a single file, convert selected folder(s), or convert all registered folders — each with a plan → confirm → execute flow and live progress. Ships in CLI v1.1.18.
- **Sync runs auto-export an Excel report** — every completed `sync` run now writes `~/.memoriahub/exports/sync-<runId>.xlsx` and prints its absolute path, from both the interactive dashboard summary and the headless command (mirroring the existing scan auto-export). The workbook has a **Summary** sheet (run metadata + totals, uploaded size in MB, timestamps as real dates) and a **Detail** sheet (one row per processed file: path, status, detail, size in MB, MIME type, media kind, media item ID, SHA-256 prefix). A failed export only warns and never blocks the run.
- **Capture-date inference for EXIF-less files** — when a file has no EXIF date taken, `sync` now infers `capturedAt` from the oldest of the file's created, modified, and accessed filesystem timestamps (oldest survives file copies/moves best) and sends the file's creation time as `originalCreatedAt` for provenance. A genuine EXIF date always takes priority and is never overridden, even if the server later re-extracts metadata. The offline `scan` preview shows the same inferred date, and the scan export's Detail sheet gains a **Date source** column (`EXIF` / `File timestamp` / blank).
- **Organize folders into date-based subfolders before syncing** — the new `memoriahub organize [folder...] [--all] [--dry-run] [-r|--recursive] [--concurrency <n>] [--json]` command reorganizes a folder's media into `YEAR/MM - Month/` subfolders (e.g. `2023/07 - July/`) before it's ever synced, so the on-server layout starts clean. It reads each photo's EXIF capture date from the full file, not just the header, so a date buried deep in the file is never missed; files with no EXIF capture date — which currently includes every video, since the CLI doesn't probe video metadata — are moved into a top-level `NODATE/` folder instead. Already-correctly-bucketed files are skipped on re-run (idempotent), a collision with a different file at the destination appends ` (1)`, ` (2)`, … rather than overwriting, and moves fall back to copy+delete when a direct rename fails across filesystems (`EXDEV`). Also reachable from the interactive menu under `Settings ▸ Organize folder by date`, which walks through a plan → confirm → execute flow with a live progress bar. Ships in CLI v1.1.16.

## [1.1.0] - 2026-07-03

### Changed

- **CLI login now uses device authorization (browser approval) and receives a 90-day token; `--token` fallback retained** — running `memoriahub login` initiates the RFC 8628 device-auth flow: the CLI prints a verification URL + user code, best-effort opens a browser, and polls until the user approves the device. The server issues a 90-day Personal Access Token (revocable from the web app under Personal Access Tokens). Use `--server <url>` to skip the URL prompt; use `--token <pat>` for CI/headless environments where an existing PAT is supplied directly.
- **Interactive menu is now hierarchical with a navigation stack** — the flat action list was restructured into `Sync ▸` / `Reports ▸` / `Settings ▸` / `Tools ▸` submenus; `Esc`/`q` now pops back one level instead of jumping straight to the root menu, and the ASCII banner + connected-server/account identity box render only at the root. The logged-out menu is reduced to Login, Settings ▸ (Factory reset only), Help, and Quit.

### Added

- **SQLite sync persistence** — all sync state (folders, files, run history, settings) is now stored in `~/.memoriahub/memoriahub.db` via `better-sqlite3`; state survives restarts and crashes
- **Folder registry** — `memoriahub folders add|list|remove|enable|disable`; folders are registered once and referenced by ID or path in all subsequent commands
- **Multi-folder sync** — `memoriahub sync --all` syncs every enabled registered folder; `memoriahub sync [folder...]` syncs specific folders (auto-registers unknown paths)
- **Retry and issue tracking** — failed uploads are recorded with `attempt_count` and `last_error`; `memoriahub retry` re-queues them up to the `attempts_cap` setting; `--force` resets blocked files
- **Crash recovery** — files stuck in `uploading` status from a crashed run are automatically reset to `queued` on the next startup
- **Interactive Ink TUI** — `memoriahub` (bare, in a TTY) or `memoriahub menu` launches a full-screen Ink/React terminal UI with a home menu, live sync dashboard (Claude-Code-style block-grid progress meter, per-file upload bars, event log, run summary), interactive folder manager, and folder multi-select picker
- **`settings` command** — `memoriahub settings list|get|set` for `concurrency` (default 3) and `attempts_cap` (default 5)
- **`status --runs`** — view recent sync run history (last 20 runs) in addition to the folder overview
- **`--json` output** — `folders list`, `status`, and `status --runs` all support `--json` for machine-readable output
- **Legacy manifest auto-import** — on first run after upgrade, existing JSON manifests under `~/.memoriahub/manifests/` are imported into SQLite automatically (idempotent, atomic, non-destructive)
- **ESM migration** — the CLI package is now a pure ESM module (`"type": "module"` in `package.json`); `better-sqlite3` is loaded via `createRequire` for CJS interop
- **`import` command** (legacy alias) — `memoriahub import <folder>` is preserved as a back-compatibility alias for `sync <folder>`
- **Extensible reports registry** — a shared registry of report definitions now backs both the TUI's `Reports ▸` submenu and the new headless `reports` command; adding a report to the registry automatically surfaces it in both places
- **`reports` command** — `memoriahub reports list [--json]` lists available reports; `memoriahub reports show <id> [--json]` runs one (`overview`, `runs`, `storage`, `duplicates`) and prints a table or JSON
- **"Storage synced" report** — count plus total/average bytes of uploaded media
- **"Duplicates" report** — files skipped during sync because the server already had identical content, backed by a new persisted `skip_reason` column (migration v6)
- **Job queue monitor and Backup reachable from the TUI** — `Tools ▸ Job queue monitor` and `Tools ▸ Backup` expose the previously CLI-only `memoriahub jobs` (alias `queue`) and `memoriahub backup` commands from the interactive menu
