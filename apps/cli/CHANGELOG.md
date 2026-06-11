# Changelog — @memoriahub/cli

All notable changes to the CLI package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

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
