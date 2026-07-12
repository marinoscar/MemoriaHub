# CLI Date Inference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | July 2026 |
| **Status** | Implemented |

Cross-references: [CLI Metadata Override (memoriahub.json)](cli-metadata-override.md) | [CLI Scan](cli-scan.md)

---

## Table of Contents

1. [Overview and Motivation](#1-overview-and-motivation)
2. [Filename Pattern Catalog and Validation Rules](#2-filename-pattern-catalog-and-validation-rules)
3. [Diagnose Flow](#3-diagnose-flow)
4. [Apply Flow](#4-apply-flow)
5. [ExifTool Dependency Model](#5-exiftool-dependency-model)
6. [Report Schema](#6-report-schema)
7. [Command and TUI Reference](#7-command-and-tui-reference)
8. [Worked Examples](#8-worked-examples)
9. [Implementation Notes](#9-implementation-notes)

---

## 1. Overview and Motivation

A meaningful slice of real-world media libraries carries no capture date at all: no EXIF `DateTimeOriginal`/`CreateDate`/`ModifyDate` on the photo, and no usable container date on the video. This happens when a file has passed through a re-share or export step that strips metadata, but its *filename* still encodes the date — because the app that produced it baked the date into the name in the first place.

Two concrete, real examples motivate this tool:

- `20151107_135151000_iOS.jpg` — an iOS-style photo export, where the date and time are embedded directly in the filename (`20151107` = 2015-11-07, `135151000` = 13:51:51 plus milliseconds).
- `IMG-20151228-WA0007.jpg` — a WhatsApp re-share, which strips EXIF entirely but preserves the original send date in the filename (`20151228` = 2015-12-28).

Without something like `date-infer`, files like these keep no reliable capture date, which means they sort incorrectly on the timeline, are excluded from date-range filters and searches, and (for the sync path specifically) fall back to a filesystem-timestamp guess that reflects when the file happened to be *copied* rather than when it was *taken* (see [CLI Scan §4](cli-scan.md#4-metadata-extraction-scope) and the CLI README's [Capture-date inference](../../apps/cli/README.md#capture-date-inference) section for that separate, sync-only fallback ladder).

`date-infer` closes this specific gap: it is a fully offline, local-only tool that (1) finds files with no existing capture date, (2) tries to parse a date out of the filename using a small ordered catalog of high-signal patterns, and (3) — only on explicit request — writes that inferred date permanently into the file's own metadata via ExifTool, so every downstream consumer (this CLI's own `sync`/`scan`/`organize`, any other tool, the file's own properties) sees a real date from then on. It is deliberately opt-in, dedicated, and separate from `sync`'s automatic filesystem-timestamp fallback: parsing a date out of a filename is a much stronger signal than a file's mtime, but it is also a heuristic that can occasionally be wrong (a coincidental 8-digit run, a renamed file), so it is never applied silently as part of an upload — a user runs it deliberately, previews it with `diagnose`, and only then commits with `apply`.

Architecturally, `date-infer` mirrors the existing `organize`/`convert` local file tools exactly: same folder-registry auto-registration, same worker-pool concurrency model, same event-driven engine emitting typed events to a headless renderer or an Ink TUI screen, no PAT, no network call, no per-circle scoping.

---

## 2. Filename Pattern Catalog and Validation Rules

Implemented in `apps/cli/src/date-inference/filename-date.ts`, `parseDateFromFilename()` is pure (no I/O) and tries four ordered regular expressions against a file's basename, most specific/highest-signal pattern first. The **first** pattern that both matches structurally and passes calendar validation wins — later patterns are never tried once one succeeds.

| Priority | Pattern id | Shape | Example | Time component? |
|----------|-----------|-------|---------|------------------|
| 1 (highest) | `whatsapp` | `IMG-YYYYMMDD-WA####` / `VID-YYYYMMDD-WA####` | `IMG-20151228-WA0007.jpg` | No |
| 2 | `timestamp` | `YYYYMMDD` + separator (`_` or `-`) + `HHMMSS` + optional 0–3 trailing digits (milliseconds, discarded) | `20151107_135151000_iOS.jpg`, `PXL_20260704_120000.mp4`, `Screenshot_20260704-120000.png` | Yes |
| 3 | `delimited` | `YYYY-MM-DD` / `YYYY_MM_DD` / `YYYY.MM.DD` | `2015-01-15_beach.jpg` | No |
| 4 (lowest) | `bare` | Bare 8-digit `YYYYMMDD`, digit-run-guarded (negative lookaround on both sides) so it never matches inside a longer digit run — a 10/13-digit unix timestamp, a long numeric ID | `20150115.jpg` | No |

`bare` is deliberately tried last and is the lowest-confidence pattern: an 8-digit run with no delimiter or recognizable prefix is the easiest to false-positive on, so every more specific/structured pattern gets first refusal.

### Validation rules

A structural regex match alone is not sufficient — every candidate is additionally validated before being accepted:

- **Year bounds:** `year >= 2003` (the tool's `MIN_YEAR` constant) and `year <= currentYear` (the current year at run time, injectable via `opts.now` for tests) — together these bound every candidate to a plausible digital-photography-era range and reject coincidental digit runs that fall outside it.
- **Month bounds:** `1 <= month <= 12`.
- **Day bounds:** `1 <= day <= 31`.
- **Calendar round-trip check:** the year/month/day are round-tripped through `Date.UTC(year, month - 1, day)` and the resulting `Date`'s year/month/day are compared back against the inputs. An impossible date (e.g. `2015-02-30`, `2023-04-31`) rolls over into the next month under `Date.UTC`, so the round-tripped components no longer match what was asked for and the candidate is rejected. This check also handles leap years correctly for free (`2024-02-29` round-trips cleanly; `2023-02-29` does not).
- **Time bounds (pattern 2 only):** when the pattern carries an `HHMMSS` component, `hour <= 23`, `minute <= 59`, and `second <= 59` are each required; an out-of-range time invalidates the whole candidate (the engine does not fall back to treating it as date-only).

### Noon default for date-only patterns

Patterns 1, 3, and 4 carry no time component. When one of them matches, the written time defaults to **12:00:00 local noon** (`hadTime: false` on the returned match) rather than midnight. This is the identical rationale already established for [`memoriahub.json`'s date-only `capturedAt` expansion](cli-metadata-override.md#3-schema-reference): midnight sits at the very edge of a calendar day, so a later timezone reinterpretation (server timezone handling, a viewer in a different offset, a DST edge case) risks shifting the value onto the *previous* calendar date, whereas noon cannot be pushed across a date boundary by any plausible offset shift.

---

## 3. Diagnose Flow

`memoriahub date-infer diagnose` runs the `DateInferenceEngine` (`apps/cli/src/date-inference/date-inference-engine.ts`) in `mode: 'diagnose'`, which never writes to disk.

For every file discovered under the target folder(s):

1. **Existing-date check.** The engine calls the exact same `readExifPlacement(filePath, mimeType, { full: true })` helper `organize` uses — a full-file EXIF read for photos, a container-metadata (ffprobe) probe for videos, not just a fast header peek. If a capture date is found, the file's status is `has_date` and processing stops there: **the filename is never even parsed.** This is what makes the tool safe to run repeatedly and safe to run over a mixed folder — a file that already has a reliable date is never second-guessed by a filename heuristic.
2. **Filename parse.** Only files with no existing date reach `parseDateFromFilename(basename)` (§2). No match → status `no_pattern` ("nothing this tool can do" for that file). A match → status `inferred`, recording the matched pattern id, the matched substring, and the resulting ISO-shaped candidate date.

`diagnose` performs step 2 but stops before writing anything — no ExifTool dependency is loaded or even referenced on this path.

### Report shape

The engine accumulates roll-up `DateInferenceTotals` (`apps/cli/src/date-inference/events.ts`) as it goes:

```ts
interface DateInferenceTotals {
  total: number;
  hasDate: number;
  inferred: number;
  noPattern: number;
  written: number;      // always 0 in diagnose mode
  writeFailed: number;  // always 0 in diagnose mode
  errors: number;
  byPattern: Record<'whatsapp' | 'timestamp' | 'delimited' | 'bare', number>;
}
```

alongside a per-file event stream (`DateInferenceFilePayload`) carrying `filePath`, `mediaKind` (`photo`|`video`), `status`, and — depending on status — `existingCapturedAt`, `matchedPattern`, `matchedText`, `inferredDate`, or `error`. Both the headless command and the TUI screen accumulate these file-level events into an array for the exported report and (in the TUI) a sample display.

---

## 4. Apply Flow

`memoriahub date-infer apply` runs the identical engine pass in `mode: 'apply'`. Every step in §3 is unchanged through the `inferred` determination; the only difference is what happens next: instead of stopping at `inferred`, the engine calls `writeCapturedDate(filePath, match)` (`apps/cli/src/date-inference/exif-writer.ts`) and records `written` or `write_failed` depending on the result.

### Why `AllDates` + `-overwrite_original`

`writeCapturedDate` writes through ExifTool's `AllDates` shortcut tag rather than naming individual tags. ExifTool maps `AllDates` to the correct concrete tag group automatically per file format in a single call:

- **Photos:** EXIF `DateTimeOriginal`, `CreateDate`, and `ModifyDate`.
- **Videos:** the QuickTime/MP4 `CreateDate` and `ModifyDate` atoms.

This means one code path covers both media kinds without the caller needing to branch on file type.

`-overwrite_original` is passed explicitly as a `writeArgs` option. ExifTool's default behavior on a write is to preserve the original file as `<file>_original` next to the modified one — a safety net most tools want, but not this one. `date-infer apply` is **destructive-by-design**: the whole point is to bake a date permanently into the file the user already has, not to create a second copy. Leaving `_original` backups scattered across every processed folder would be surprising, would double disk usage for no benefit the tool intends to provide, and was a deliberate design rejection rather than an oversight.

### Idempotency

Because the write goes into the file's real EXIF/container date fields, a subsequent `diagnose` (or `apply`) pass on the same file sees it via the exact same `readExifPlacement()` check described in §3, step 1 — the file's status is now `has_date`, and its filename is never re-parsed. Running `date-infer diagnose` again after an `apply` run is therefore the correct way to confirm the writes landed: previously-`inferred` files should now report as `has_date` with an `existingCapturedAt` that matches what was written.

### Failure isolation

Every per-file write goes through `writeCapturedDate`, which never throws — any failure (permission denied, a corrupt file, a format ExifTool can't write to) resolves `{ ok: false, error }` rather than propagating, so one bad file in a large batch never aborts the run. The engine additionally wraps the whole per-file body in a try/catch (`status: 'error'`) as a second layer of isolation against anything unexpected in the placement read or filename parse itself.

---

## 5. ExifTool Dependency Model

**This is not a "please go install ExifTool yourself" dependency.** `apps/cli/package.json` lists `exiftool-vendored` at `35.21.0` under `optionalDependencies`. That package **vendors the ExifTool script itself** through its own optional sub-dependencies:

- `exiftool-vendored.pl` on macOS/Linux — the actual ExifTool Perl script, bundled inside the npm package. Running it needs a `perl` interpreter on `PATH`, which ships by default on virtually every POSIX system (Linux distributions and macOS both include one out of the box).
- `exiftool-vendored.exe` on Windows — a self-contained compiled binary. No Perl interpreter is needed on Windows.

`35.21.0` is pinned deliberately as the last version of `exiftool-vendored` supporting this CLI's `node >=20` engine requirement — `36.0.0` and later require Node 22.

### Placement rationale

`exiftool-vendored` sits in `optionalDependencies` alongside the CLI's other heavy, not-always-needed native/runtime pieces (`sharp`, `onnxruntime-node`, `@vladmandic/human`, `tesseract.js`). Only the `apply` phase needs it — `diagnose` is fully read-only and never imports it. `exif-writer.ts` dynamically `import()`s the package lazily and memoizes the result, so a lean CLI install (`npm install --no-optional`, or an environment where the optional install step failed) doesn't force this dependency onto every user, and the read-only `diagnose` path is completely unaffected either way.

### Detection and failure UX

Because the optional install can be skipped, or `perl` can be missing even when the npm package is present, detection has to be defensive rather than assumed. `detectExiftool()` (memoized for the process lifetime, mirroring `convert`'s `detectFfmpeg()` discipline) attempts the dynamic import and, on success, calls `exiftool.version()` as a live liveness check — never throws, always resolves `{ available: boolean, version?: string }`.

- **Headless `apply`:** checks `detectExiftool()` up front, before any folder walking begins. If unavailable, the command prints the install/recovery hint (`exiftoolInstallHint()`) and exits non-zero without touching any files.
- **TUI "Infer & write dates":** the diagnose-first report phase never needs ExifTool. Only when the user explicitly presses `[a]` to proceed toward writing does the screen transition to a `checkingTool` phase and call `detectExiftool()`; on failure it shows a dedicated `toolUnavailable` screen with the same install hint text, with a path back to the report.

The install hint itself: reinstall with optional dependencies included (`npm install --include=optional -g @memoriahub/cli`), and on Linux/macOS confirm a `perl` interpreter is on `PATH`.

### Process lifecycle

`exiftool-vendored` keeps a single long-lived child process alive across every `write()` call — much faster than spawning a fresh ExifTool process per file, which matters at the batch sizes this tool is meant for. `endExiftool()` shuts that shared process down and must be called exactly once after a whole `apply` run finishes (both the headless command's `finally` block and the TUI screen's apply-pass completion handler do this) — never per file. It is a safe no-op if ExifTool was never loaded in the first place (e.g. a `diagnose`-only session, or an `apply` run that exited early on the availability check).

---

## 6. Report Schema

Implemented in `apps/cli/src/export/date-inference-export.ts`, mirroring `scan`'s report-export shape: the heavy `exceljs` dependency is loaded via dynamic import, and the caller passes the in-memory totals plus the accumulated per-file event records straight from the engine — there is no persisted run to read back from disk (see below).

### xlsx (default `--format`)

- **Summary sheet** — a "Date Inference" header block naming the mode (`Diagnose (report only)` or `Apply (wrote dates)`), a "Totals" block (`total`, `hasDate`, `inferred`, `noPattern`, plus `written`/`writeFailed` only in apply mode, plus `errors`), and a "Matched pattern breakdown" block listing only the patterns that actually matched at least one file.
- **Detail sheet** — one row per processed file: `File path`, `Media kind`, `Status` (human-readable label, e.g. "Inferred from filename", "Written to file", "Write failed"), `Matched pattern`, `Matched text`, `Inferred date`, `Existing captured at`, `Error`. The header row is frozen (`ySplit: 1`), and the two date columns are converted from ISO strings into real Excel datetime cells (formatted via the shared `DATE_FMT`) so they sort and render as dates rather than plain text.

### csv (`--format csv`)

The Detail sheet's columns only, RFC 4180-escaped, written directly to disk — no Summary equivalent in CSV output.

### No persistent run history

Unlike `scan`, which persists every run into the CLI's local SQLite database for later `scan list`/`scan report`, `date-infer` keeps **no database row for a run at all** — this mirrors `convert`'s stateless error-report approach, not `scan`'s snapshot model. The exported xlsx/csv file at `~/.memoriahub/exports/date-infer-<diagnose|apply>-<timestamp>.xlsx` (or `.csv`) is the only durable artifact of a given run; there is no `date-infer list` or `date-infer report <id>` equivalent to `scan`'s.

---

## 7. Command and TUI Reference

### CLI subcommands

```bash
memoriahub date-infer diagnose [folder...] [--all] [-r] [--concurrency <n>] [--json] [--format xlsx|csv]
memoriahub date-infer apply    [folder...] [--all] [-r] [--concurrency <n>] [--json] [--format xlsx|csv]
```

| Flag | Description |
|------|-------------|
| `[folder...]` | One or more folder paths. Unknown paths are auto-registered (same as `scan`/`organize`/`convert`). Omit and pass `--all` instead. |
| `--all` | Target every registered, enabled folder instead of specific paths. |
| `-r`, `--recursive` | Descend into sub-directories when auto-registering an ad-hoc folder path. |
| `--concurrency <n>` | Worker-pool concurrency override; falls back to the settings-configured default. |
| `--json` | Emit the totals object (plus `reportPath`) as JSON instead of the summary box. |
| `--format <xlsx\|csv>` | Report output format. Default `xlsx`. |

`diagnose` is fully read-only: no PAT, no network, no writes. `apply` checks ExifTool availability up front (§5) and shuts down the shared ExifTool child process (`endExiftool()`) in a `finally` block once the run completes or fails. Neither command prompts for interactive confirmation in headless mode — like `organize`/`convert`, the documented workflow is "run `diagnose` first to preview, then `apply`."

### TUI: Tools ▸ Date Inference

Two menu leaves under **Tools ▸ Date Inference** (`apps/cli/src/tui/menu-config.ts`), both marked `loggedOut: true` since the tool is a fully offline local file operation:

- **Diagnose (report only)**
- **Infer & write dates**

`DateInferenceScreen.tsx` implements a single phase machine that both leaves share, regardless of which one launched the screen — it **always** runs a read-only diagnose pass first:

| Phase | What's shown | Keys |
|-------|---------------|------|
| `diagnosing` | Spinner + live processed/total count while the read-only pass runs | — |
| `report` | Totals breakdown (scanned / already dated / inferred / no pattern), up to 8 sample matched filename → date pairs, and the auto-exported report path | `[a]` write inferred dates (apply mode + candidates only) · `[q]`/Esc back · `[h]` home |
| `checkingTool` | Spinner while `detectExiftool()` runs | — |
| `toolUnavailable` | The install hint from §5 | `[q]`/Esc back to report · `[h]` home |
| `confirm` | Explicit warning that this **writes metadata into N file(s) on disk** | `[y]` proceed to write · `[q]`/Esc cancel back to report |
| `applying` | Spinner + live processed/total count while the real write pass runs | — |
| `done` | Final totals (written / write failures / already had a date / no pattern found) + export path | `[q]`/Esc back · `[h]` home |
| `empty` | No media files found in the selected folder(s) | `[q]`/Esc back · `[h]` home |
| `error` | Engine error, red border | `[q]`/Esc back · `[h]` home |

The screen is opened via the interactive menu with either `mode: 'diagnose'` or `mode: 'apply'`; a `mode: 'diagnose'` launch never offers the `[a]` transition even if candidates exist, so "Diagnose (report only)" is genuinely report-only end to end. The report phase is terminal for that launch. `mode: 'apply'` additionally offers `[a]` when `diagnoseTotals.inferred > 0`, which walks the availability check → confirm → real apply-pass sequence above.

---

## 8. Worked Examples

### `20151107_135151000_iOS.jpg` — the `timestamp` pattern

A file with no EXIF date, dropped in a scanned-import folder. `parseDateFromFilename` tries `whatsapp` (no match), then `timestamp`, which matches `20151107_135151000`:

- `year=2015, month=11, day=07` → passes bounds and calendar round-trip.
- `hour=13, minute=51, second=51` → all within bounds; the trailing `000` (milliseconds) is matched but discarded.
- `hadTime: true`.

`diagnose` reports status `inferred`, `matchedPattern: 'timestamp'`, `matchedText: '20151107_135151000'`, `inferredDate: '2015-11-07T13:51:51.000Z'` (the wall-clock value from the filename, not a UTC instant conversion — same convention as the CLI's other date-parsing helpers). `apply` writes `AllDates = "2015:11:07 13:51:51"` via ExifTool with `-overwrite_original`, so the JPEG's `DateTimeOriginal`/`CreateDate`/`ModifyDate` are now `2015-11-07 13:51:51`. A follow-up `diagnose` on the same file now reports `has_date` with `existingCapturedAt` matching that value — the filename is never parsed again.

### `IMG-20151228-WA0007.jpg` — the `whatsapp` pattern

A WhatsApp re-share with no EXIF at all (WhatsApp strips it on send). `parseDateFromFilename` matches the `whatsapp` pattern first (highest priority): `year=2015, month=12, day=28`. There is no time component in this pattern, so the match carries `hadTime: false`, and the write defaults to local noon.

`diagnose` reports `inferred`, `matchedPattern: 'whatsapp'`, `matchedText: 'IMG-20151228-WA0007'`, `inferredDate: '2015-12-28T12:00:00.000Z'`. `apply` writes `AllDates = "2015:12:28 12:00:00"` — the same noon-default rationale as [`memoriahub.json`'s date-only expansion](cli-metadata-override.md#3-schema-reference) applies here: no plausible later timezone reinterpretation can shift `12:00:00` across a calendar-day boundary, so the file reliably displays as December 28, 2015 everywhere its date is shown.

---

## 9. Implementation Notes

Source files (all under `apps/cli/src/`):

| File | Responsibility |
|------|-----------------|
| `date-inference/filename-date.ts` | Pure filename → candidate-date parser (§2); no I/O, no dependencies. |
| `date-inference/exif-writer.ts` | ExifTool-backed writer (§4, §5); dynamic import of the optional `exiftool-vendored` dependency, detection, `AllDates` write, process lifecycle. |
| `date-inference/date-inference-engine.ts` | `DateInferenceEngine` — walks folders, drives the existing-date check → filename parse → (apply-mode) write sequence per file over a bounded worker pool (`sync/worker-pool.ts`), emits typed events. |
| `date-inference/events.ts` | Typed event contract (`DATE_INFERENCE_EV`, totals, per-file payload shapes) consumed by both the headless renderer and the TUI screen. |
| `export/date-inference-export.ts` | xlsx/csv report writer (§6). |
| `commands/date-infer.ts` | `memoriahub date-infer diagnose\|apply` command wiring, folder resolution/auto-registration, ExifTool pre-flight check, report export, headless rendering. |
| `tui/DateInferenceScreen.tsx` | Ink/React TUI screen (§7) — phase state machine, diagnose-first flow, confirm step before writing. |
| `tui/menu-config.ts` | Menu entries: **Tools ▸ Date Inference ▸** Diagnose (report only) / Infer & write dates. |

`date-infer` reuses two pieces of shared CLI infrastructure rather than reimplementing them: `readExifPlacement()` from `apps/cli/src/metadata.ts` (the same full-file EXIF/container read `organize` uses) for the existing-date check, and `runPool()` from `apps/cli/src/sync/worker-pool.ts` for bounded-concurrency processing.

**Relationship to `memoriahub.json` ([CLI Metadata Override](cli-metadata-override.md)):** the two features are complementary, not overlapping, and solve the gap from opposite directions. `memoriahub.json` supplies a fallback date (and/or location) **at upload time**, applied server-side to the `MediaItem` record when the file itself has no EXIF — it never touches the file's own bytes, and its effect is scoped to that one `sync` run's server-side record. `date-infer` instead bakes a date **into the file itself**, permanently and independently of any upload, using ExifTool. Use `memoriahub.json` when you don't want to (or can't) modify source files, or when you also need to supply GPS coordinates alongside the date — `date-infer` has no location-inference capability at all. Use `date-infer` when the filename already encodes a real date and you want that date to become a durable, portable property of the file, visible to `sync`'s own EXIF read, to `organize`, to any other tool, and to the file's own OS-level properties — not just to this one MemoriaHub upload.

**Relationship to `scan`'s date handling ([CLI Scan](cli-scan.md)):** `scan` reads the capture date from EXIF alone and reports it as missing when EXIF has none — it deliberately never falls back to a filesystem timestamp or a filename guess (see the CLI README's [Capture-date inference](../../apps/cli/README.md#capture-date-inference) section, which documents this explicitly for the `scan`-vs-`sync` distinction). `date-infer` does not violate or contradict that principle: `scan` is a passive, read-only inventory of what a file's EXIF *already* says, by design conservative about not guessing. `date-infer` is a different, opt-in, dedicated tool that a user runs deliberately specifically to turn a filename-encoded date into a real one — and once `apply` has run, `scan`'s own EXIF-only read will pick up that now-real date exactly as it would any other camera-written date, with no special-casing needed on `scan`'s side at all.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | July 2026 | AI Assistant | Initial specification |
