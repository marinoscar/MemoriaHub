# Changelog — @memoriahub/cli

All notable changes to the CLI package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- **Sync runs auto-export an Excel report** — every completed `sync` run now writes `~/.memoriahub/exports/sync-<runId>.xlsx` and prints its absolute path, from both the interactive dashboard summary and the headless command (mirroring the existing scan auto-export). The workbook has a **Summary** sheet (run metadata + totals, uploaded size in MB, timestamps as real dates) and a **Detail** sheet (one row per processed file: path, status, detail, size in MB, MIME type, media kind, media item ID, SHA-256 prefix). A failed export only warns and never blocks the run.

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
