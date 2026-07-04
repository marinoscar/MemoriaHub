# CLI Scan — Pre-Sync Dry-Run Preview

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | July 2026 |
| **Status** | Implemented |

Cross-references: [Bulk Import Resilience](bulk-import-resilience.md) | [Job Queue Insights](job-insights.md)

---

## Table of Contents

1. [Overview and Motivation](#1-overview-and-motivation)
2. [Command Surface](#2-command-surface)
3. [Data Model](#3-data-model)
4. [Metadata Extraction Scope](#4-metadata-extraction-scope)
5. [Report and Dashboard](#5-report-and-dashboard)
6. [Excel and CSV Export](#6-excel-and-csv-export)
7. [Scan-to-Sync Reconciliation](#7-scan-to-sync-reconciliation)
8. [Source Architecture](#8-source-architecture)

---

## 1. Overview and Motivation

`scan` is a fully offline, read-only dry run that answers the question a user has before committing to a long `sync`: *what exactly is in this folder, and is it healthy?* It enumerates every file a sync would process, reads lightweight local metadata from each file, and persists an immutable snapshot in the CLI's local SQLite database. The result is rendered as a dashboard report and can be exported to Excel for offline review or sharing.

Two problems motivate this feature:

- **Previewing library composition and health before committing to a long upload.** Bulk imports of thousands of files can run for hours (see [Bulk Import Resilience](bulk-import-resilience.md)). Before kicking one off, users want a fast, local answer to "how many files, how big, what's the photo/video split" without touching the server or a PAT.
- **Catching metadata gaps ahead of time.** Photos with missing EXIF or missing GPS are common in libraries assembled from multiple sources (phone exports, WhatsApp re-shares, old scanned photos). `scan` surfaces EXIF and location coverage percentages up front, so a user can decide whether to fix source files before uploading rather than discovering gaps circle-by-circle after the fact in the web UI.

Because `scan` never uploads, never hashes file contents, and never calls the server, it can be run as often as desired with no cost beyond local disk reads.

---

## 2. Command Surface

All `scan` subcommands are offline and local — no PAT or server connection is required. The only command in this feature area that talks to the server is `sync --scan`, because it proceeds to actually upload.

| Command | Flags | Description |
|---------|-------|-------------|
| `scan [folder...]` | `--all` / `--json` / `--no-report` / `-r, --recursive` / `--concurrency <n>` | Run a scan and persist it, then render the report |
| `scan list` | `--json` | List recent scans |
| `scan report [id]` | `--json` | Re-render a previously stored scan (defaults to the latest) |
| `scan export <id>` | `--out <file>` / `--format xlsx\|csv` | Export a stored scan to an Excel workbook or CSV file |
| `sync --scan <id\|latest>` | (extends existing `sync` flags) | Reconcile target folders against a scan snapshot, then upload |

### `memoriahub scan`

```bash
# Scan all registered folders
memoriahub scan --all

# Scan one or more specific folders (auto-registers if not yet known, same as sync)
memoriahub scan ~/Pictures/Vacation2024

# Scan recursively when auto-registering
memoriahub scan ~/Pictures -r

# Machine-readable JSON output instead of the dashboard/tables
memoriahub scan --all --json

# Persist the scan but skip rendering a report (useful when scripting export afterward)
memoriahub scan --all --no-report

# Override the concurrent file-read worker count for this run
memoriahub scan --all --concurrency 5
```

`scan` auto-registers unknown folder paths, exactly as `sync` does — passing a path that is not yet in the folder registry adds it before scanning.

Rendering mode is selected automatically based on the output context: an Ink dashboard when attached to a TTY, plain tables when output is piped or redirected, and raw JSON when `--json` is passed. See [Section 5](#5-report-and-dashboard).

### `memoriahub scan list`

```bash
memoriahub scan list
memoriahub scan list --json
```

Lists recent scan runs (most recent first), each identified by its scan ID and timestamp.

### `memoriahub scan report`

```bash
# Re-render the most recent scan
memoriahub scan report

# Re-render a specific scan by ID
memoriahub scan report 12

# JSON output
memoriahub scan report 12 --json
```

Re-renders a stored scan without re-scanning the filesystem. Useful for revisiting a prior scan's numbers, or for generating JSON output from a scan that was originally run interactively.

### `memoriahub scan export`

```bash
# Export the latest-known scan ID to an Excel workbook
memoriahub scan export 12 --out scan-report.xlsx

# Export to CSV instead
memoriahub scan export 12 --out scan-report.csv

# Format can also be forced explicitly rather than inferred from the extension
memoriahub scan export 12 --out report.dat --format csv
```

Export format is inferred from the `--out` file extension (`.xlsx` or `.csv`); `--format` overrides the inference when the extension is ambiguous. See [Section 6](#6-excel-and-csv-export).

### `memoriahub sync --scan`

```bash
# Reconcile the target folders against scan 12 before syncing
memoriahub sync ~/Pictures/Vacation2024 --scan 12

# Reconcile against the most recently stored scan
memoriahub sync --all --scan latest
```

See [Section 7](#7-scan-to-sync-reconciliation) for the reconciliation behavior. A `sync` invoked without `--scan` is completely unchanged from before this feature existed — no reconciliation, no dependency on the scan tables.

---

## 3. Data Model

### Migration v6

Two new tables are added by SQLite schema migration v6, on top of the version-gated migration runner (`db/migrations.ts`, `PRAGMA user_version`) described in [Bulk Import Resilience](bulk-import-resilience.md). Both tables are kept **out of** the mutable `files` table that `sync` uses as its ledger, specifically so a persisted scan snapshot remains untouched by later sync activity and can be diffed against at sync time (see [Section 7](#7-scan-to-sync-reconciliation)). If scan data lived in `files`, a subsequent sync updating that same table would overwrite the very state the scan was meant to freeze.

### `scans` table

One row per scan run — a rollup/summary of that run's results.

| Column (approximate) | Description |
|---|---|
| Scan ID | Primary key |
| Created timestamp | When the scan was run |
| Folder scope | Which folder(s)/registry entries the scan covered |
| Total file count | Files enumerated in this run |
| Photo count / video count | Split by media type |
| Total size in bytes | Overall size, plus size broken down by photo/video |
| EXIF coverage stats | Count/percentage of photos with `has_exif = true` |
| GPS coverage stats | Count/percentage of photos with `has_gps = true` |
| Capture-date coverage stats | Count/percentage of photos with a recognized capture date |

### `scan_files` table

One **immutable** row per file per scan — the per-file detail backing the summary above.

| Column (approximate) | Description |
|---|---|
| Scan ID | FK → `scans` |
| Folder ID | FK → the folder registry, same as used by `files` |
| File path | Absolute path on disk at scan time |
| File size | Bytes, read at scan time |
| Modified time (mtime) | Read at scan time, used later for scan-to-sync drift comparison |
| Media type | Photo or video classification |
| `has_exif` | Boolean — EXIF header present |
| `has_gps` | Boolean — GPS coordinates present in EXIF |
| Bonus columns (Excel Detail sheet only) | Captured-at date, width/height dimensions, camera make/model, latitude/longitude — see [Section 4](#4-metadata-extraction-scope) |

The unique constraint `UNIQUE(scan_id, folder_id, file_path)` guarantees at most one row per file within a given scan, while still allowing the same file path to appear across multiple historical scans (each with its own `scan_id`) so repeated scans of the same folder are all preserved as independent snapshots.

---

## 4. Metadata Extraction Scope

Metadata is read via `exifr` — the monorepo's standard EXIF-reading library, also used elsewhere in the codebase — reading only file **headers**, not full file bodies. This keeps a scan fast even across very large libraries.

**Two primary flags** are recorded per photo, and are the two numbers surfaced most prominently in the report:

- `has_exif` — whether any EXIF metadata block was present at all
- `has_gps` — whether EXIF included GPS/location coordinates

**Bonus columns**, extracted from the same header read but surfaced **only in the Excel Detail sheet** (not in the terminal dashboard, piped tables, or `--json` output):

- Captured-at date
- Width / height dimensions
- Camera make / model
- Latitude / longitude coordinates

**Videos** are classified (by extension/MIME type, per the same [supported file types](../../apps/cli/README.md#supported-file-types) list `sync` uses) and sized only. No ffmpeg probe or frame extraction runs during a scan — that would defeat the purpose of a fast, lightweight preview.

**No content hashing.** Scan deliberately does not compute a SHA-256 (or any) content hash for any file, unlike `sync`'s hash-cache and server dedup pre-check (see [Bulk Import Resilience](bulk-import-resilience.md)). Content hashing remains a sync-time-only operation. This is why scan-to-sync change detection (Section 7) relies on size + mtime comparison rather than hash comparison — the scan snapshot simply does not have hashes to compare against.

### Supported Formats

File discovery for `scan` (and `sync`) is extension-based only (case-insensitive) — there is no content sniffing of file bytes to determine type. A file's extension is looked up in the `MIME_BY_EXT` map (`apps/cli/src/files.ts`); if the extension is not a key in that map, the file is skipped entirely and never appears in the scan (or the sync it previews). Photo vs. video classification is decided purely by whether the resolved MIME type starts with `image/` or `video/` — there is no additional format-specific logic beyond that prefix check.

The supported extensions:

**Images — common raster:** jpg, jpeg, jpe, jif, jfif, png, gif, bmp, dib, webp, tif, tiff

**Images — modern / next-gen:** heic, heif, hif, avif, jxl, jp2, j2k, jpf, jpx

**Images — editor / misc:** psd, tga, pcx

**Images — camera RAW:** dng, cr2, cr3, crw, nef, nrw, arw, srf, sr2, orf, rw2, raw, raf, pef, dcr, kdc, mrw, 3fr, fff, mef, mos, iiq, erf, x3f, srw, rwl, gpr

**Videos — modern:** mp4, m4v, mov, qt, webm, mkv, ogv

**Videos — legacy / camcorder / broadcast:** avi, divx, wmv, asf, flv, f4v, mpg, mpeg, mpe, m1v, m2v, mpv, mp2, vob, 3gp, 3g2, mts, m2ts, m2t, ts, mxf, dv, dif, rm, rmvb, amv

The list intentionally casts a wide net — modern formats alongside legacy/camcorder/broadcast formats — so that old-device photo and video libraries can still be scanned, synced, and backed up. Successfully scanning (and later syncing/backing up) a file with an exotic extension is **not** a guarantee that a server-side thumbnail/preview will be generated for it; thumbnailing and EXIF extraction for unusual formats is a separate downstream concern from discovery, and may be limited or absent.

---

## 5. Report and Dashboard

The report shown after `scan` (or via `scan report`) covers:

- **Totals** — total file count
- **Photo vs. video split** — counts of each
- **Size** — total size, plus size broken down by photo vs. video
- **Metadata coverage** — EXIF-present percentage and location(GPS)-in-EXIF-present percentage (the two headline coverage numbers), plus capture-date coverage percentage
- **Breakdowns** — by folder, and by camera make/model
- **Largest files** — a top-N list by file size

### Three rendering modes, one source of truth

`src/scan/report.ts` is the single source of truth feeding all three renderers — it computes the shared report data structure once, and each renderer only handles presentation:

| Mode | Trigger | Renderer |
|------|---------|----------|
| Ink dashboard | Attached TTY, no `--json` | `src/tui/ScanDashboard.tsx` |
| Plain tables | Piped/redirected output, no `--json` | `src/render/headless-scan.ts` |
| Raw JSON | `--json` flag | `report.ts` output serialized directly |

Because all three modes are driven from the same computed structure, the dashboard, piped tables, and JSON output are always numerically consistent with one another — there is no separate code path that could drift out of sync with the others.

---

## 6. Excel and CSV Export

`scan export <id> --out <file>` produces either an Excel workbook or a flat CSV, with the format inferred from the `--out` file extension (or forced via `--format xlsx|csv`).

### Excel (`.xlsx`)

Built with the `exceljs` npm dependency, which is **dynamically imported** — it is not loaded or required unless an export is actually performed, keeping it out of the CLI's baseline startup cost for users who never export.

Two sheets:

- **Summary sheet** — KPIs, coverage stats (EXIF %, GPS %, capture-date %), and the folder/camera breakdowns, mirroring what the terminal report shows.
- **Detail sheet** — one row per file, including the bonus columns (captured-at, dimensions, camera make/model, lat/lng) that are only available in this export, not in the terminal/JSON report.

### CSV (`.csv`)

Hand-rolled RFC-4180 CSV writer — no additional dependency. Intended as a lightweight, dependency-free alternative for tooling that just needs a flat per-file table rather than a formatted workbook.

### TUI Auto-Export

The interactive menu (`memoriahub menu` → Scan) automatically writes an Excel workbook whenever a scan is run or an existing scan report is viewed from that menu, saving to a fixed, per-scan-id path: `~/.memoriahub/exports/scan-<id>.xlsx`. After the report renders, the dashboard prints the absolute path on a green line: `📄 Excel saved: <path>`. This is separate from the `scan export <id> --out <file>` command above — the TUI auto-export path is fixed/derived from the scan ID, whereas `scan export --out` lets the caller choose the destination file. The auto-export is idempotent (re-viewing the same scan overwrites the same file rather than creating duplicates) and non-fatal on failure (a warning is shown, but the scan report still renders regardless of export success or failure).

---

## 7. Scan-to-Sync Reconciliation

`sync --scan <id|latest>` layers a reconciliation step in front of the normal sync flow: before proceeding to upload, the CLI compares the live state of the target folder(s) against the persisted immutable scan snapshot (the `scan_files` rows for that scan).

### Classification

Each file is classified by comparing live on-disk **size and mtime** against the values recorded in `scan_files` at scan time (not content hashing — see [Section 4](#4-metadata-extraction-scope)):

| Classification | Condition |
|---|---|
| Added | Present on disk now, not present in the scan snapshot |
| Removed | Present in the scan snapshot, no longer present on disk |
| Modified | Present in both, but size and/or mtime differ |
| Unchanged | Present in both, size and mtime match |

This comparison is implemented in `src/scan/reconcile.ts`.

### Output

Before proceeding with the upload, the CLI prints a "changes since scan" summary panel showing the added/removed/modified/unchanged counts, so the user can see at a glance what has drifted since the scan was taken. The sync then proceeds against the live file set exactly as it otherwise would — the scan is a comparison reference, not a filter; nothing found by reconciliation blocks the sync from running.

### Without `--scan`

A `sync` invoked without `--scan` behaves exactly as it did before this feature existed: no reconciliation step, no read from the `scans` or `scan_files` tables, no "changes since scan" panel. The scan feature is entirely additive and opt-in at the sync layer.

---

## 8. Source Architecture

Source layout mirrors the existing `sync` architecture's structure (engine / events / persistence / rendering separation):

| File | Description |
|------|-------------|
| `src/scan/scan-engine.ts` | Event-emitting scan engine; no UI concerns (mirrors sync's engine pattern) |
| `src/scan/events.ts` | Event type definitions for the scan engine |
| `src/scan/report.ts` | Single source of truth for report computation, feeding all three renderers |
| `src/scan/reconcile.ts` | Scan-to-sync diff logic (added/removed/modified/unchanged) |
| `src/repo/scans.ts` | SQLite persistence layer for the `scans` and `scan_files` tables |
| `src/metadata.ts` | `exifr`-based metadata extraction (EXIF/GPS header reads) |
| `src/render/headless-scan.ts` | Non-TTY (piped) table rendering |
| `src/tui/ScanDashboard.tsx` | Ink TTY dashboard component |
| `src/commands/scan.ts` | `scan` / `scan list` / `scan report` command entry points |
| `src/commands/scan-export.ts` | `scan export` command entry point |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | July 2026 | AI Assistant | Initial specification |
