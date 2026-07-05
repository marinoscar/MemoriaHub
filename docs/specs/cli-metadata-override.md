# CLI Metadata Override File (memoriahub.json)

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | July 2026 |
| **Status** | Specification |

Cross-references: [CLI Scan](cli-scan.md) | [Geocoding](geocoding.md) | [Location Inference](location-inference.md)

---

## Table of Contents

1. [Overview and Motivation](#1-overview-and-motivation)
2. [Filename and Placement](#2-filename-and-placement)
3. [Schema Reference](#3-schema-reference)
4. [Merge Semantics](#4-merge-semantics)
5. [Reverse Geocoding and coordSource](#5-reverse-geocoding-and-coordsource)
6. [Validation and Error Handling](#6-validation-and-error-handling)
7. [Verifying Before You Upload](#7-verifying-before-you-upload)
8. [Worked Scenarios — Costa Rica 2019](#8-worked-scenarios--costa-rica-2019)
9. [Implementation Notes](#9-implementation-notes)

---

## 1. Overview and Motivation

When a user bulk-imports a folder of media with `memoriahub sync <folder>` (the same underlying upload path is also reachable via `import`), many files arrive with incomplete metadata. Photos scanned from an old print, exported from a messaging app, or pulled off a device with location services disabled often have **no EXIF date and no EXIF GPS at all**. Videos are worse: this pipeline never reads EXIF from video containers, so a video's date and location are always missing unless something else supplies them.

Without any override, a file with no capture date falls back to a best-effort file-timestamp guess (see [Bulk Import Resilience](bulk-import-resilience.md) for how capture dates are resolved), and a file with no GPS simply has no coordinates — it never appears on the map or in place-based browsing.

`memoriahub.json` is a small, hand-editable JSON file a user drops into a media folder before running `sync`. It supplies a **fallback** capture date and/or GPS location for files in that folder that are missing that data in their own EXIF. It never overrides metadata a file already has — it only fills gaps. This is the primary tool for correctly dating and geotagging old scanned photo folders and video-heavy folders in bulk, without hand-editing every file.

---

## 2. Filename and Placement

- The file must be named exactly `memoriahub.json` — case-sensitive, a normal visible filename (not dot-prefixed like `.memoriahub.json`).
- It is placed directly inside the media folder it applies to. It applies **only** to media files directly inside that same folder — it does **not** recurse into subfolders. A subfolder that needs its own overrides needs its own `memoriahub.json`.
- The practical workflow this is designed around: segregate a trip, a day, or a batch of old scans into its own folder (e.g. `~/Pictures/CostaRica2019/`), and drop one `memoriahub.json` into that folder describing the fallback date/location for everything in it, then run `memoriahub sync ~/Pictures/CostaRica2019`.
- The file itself is never uploaded as a media item. The CLI treats it as a control file and skips it during folder enumeration — the same way it silently skips any file whose extension is not in the supported-extensions list (see [CLI Scan §4](cli-scan.md#4-metadata-extraction-scope) for the full `MIME_BY_EXT` discussion). A `.json` file was never going to match an image or video extension in the first place, so this exclusion falls out naturally from the existing discovery logic.

---

## 3. Schema Reference

Example `memoriahub.json`:

```json
{
  "version": 1,
  "fallback": {
    "capturedAt": "2019-06-15T14:30:00-06:00",
    "location": { "latitude": 9.9281, "longitude": -84.0907, "altitude": 1170 }
  },
  "files": [
    { "name": "IMG_0042.jpg", "capturedAt": "2019-06-16", "location": { "latitude": 9.63, "longitude": -84.66 } }
  ]
}
```

### `version` (required integer)

Must be exactly `1`. Any other value — missing, a different number, a string, etc. — is a validation error (see [§6](#6-validation-and-error-handling)). This field exists so a future breaking schema change can be introduced without silently misreading old override files.

### `fallback` (optional object)

Folder-wide defaults applied to every file in the folder that doesn't already have the corresponding data (in its own EXIF, or in a more specific `files[]` entry — see [§4](#4-merge-semantics)).

| Field | Type | Required within `fallback` | Description |
|-------|------|------|-------------|
| `capturedAt` | ISO 8601 datetime or `YYYY-MM-DD` date | No | The date (and ideally time) the folder's contents were captured. |
| `location` | object | No | `{ latitude, longitude, altitude? }` — the folder's GPS fallback. |
| `location.latitude` | number | Yes, if `location` is present | Range `[-90, 90]`. |
| `location.longitude` | number | Yes, if `location` is present | Range `[-180, 180]`. |
| `location.altitude` | number | No | Meters. Optional even when `location` is present. |

**`capturedAt` date-only expansion:** `fallback.capturedAt` accepts either a full datetime with a UTC offset (preferred, e.g. `"2019-06-15T14:30:00-06:00"`) or a bare date string `"YYYY-MM-DD"`. When a date-only string is supplied, the CLI expands it to **local noon** (`12:00:00` in the offset implied by the date, i.e. treated as a wall-clock local time) rather than midnight. This is deliberate: midnight sits at the edge of the calendar day, so any subsequent UTC-offset shift (server timezone handling, a viewer in a different timezone, DST edge cases) risks pushing the timestamp to the *previous* calendar day. Noon sits in the middle of the day, so no plausible offset shift can move it across a date boundary. The result is that a date-only override reliably displays as the intended calendar date everywhere it's shown, at the cost of an arbitrary (but harmless) time-of-day component.

**`location` requires both coordinates together.** Supplying `latitude` without `longitude` (or vice versa) is a validation error — see [§6](#6-validation-and-error-handling). `altitude` alone, without both coordinates, is also invalid since `location` would then be meaningless as a position.

### `files` (optional array)

Per-file overrides, for the cases where one or a few files in the folder need something different from the folder-wide `fallback` (a file taken at a different moment, or a specific correction).

Each entry:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **Yes** | The file's exact basename (e.g. `"IMG_0042.jpg"`) — **not** a full path, and **not** a case-insensitive glob or pattern. Matching is an exact, case-sensitive string comparison against the basename of each file discovered in the folder. |
| `capturedAt` | ISO 8601 datetime or `YYYY-MM-DD` | No | Same format and same local-noon expansion rule as `fallback.capturedAt`. |
| `location` | object | No | Same shape and validation rules as `fallback.location` (`latitude`/`longitude` both required together, `altitude` optional). |

A `files[]` entry only needs to specify the field(s) it wants to override — see [§4](#4-merge-semantics) for exactly how a partial entry composes with the folder `fallback`.

**Duplicate `name` values in `files[]` are a validation error.** If the same basename appears twice, the CLI cannot determine which entry should win, so the whole file is rejected rather than silently picking one (see [§6](#6-validation-and-error-handling)).

---

## 4. Merge Semantics

### EXIF always wins, per field, independently

The override file only ever fills a **gap**. If a file already has EXIF data for a given field, the override is ignored for that field — even if the file also has a `files[]` entry or the folder has a `fallback`. Critically, this evaluation happens **per field, independently**, not per file as an all-or-nothing choice:

- A photo with an EXIF capture date but **no** EXIF GPS keeps its EXIF date and receives the override's location.
- A photo with EXIF GPS but **no** EXIF capture date keeps its EXIF GPS and receives the override's date.
- A photo with both already keeps both — the override contributes nothing for that file.
- A photo with neither receives both fields from the override.

### Videos always take the override

This pipeline does not read EXIF from video containers, so a video file has no EXIF date and no EXIF GPS by definition. Every video in a folder governed by a `memoriahub.json` receives whatever the override supplies (folder `fallback`, or a more specific `files[]` entry) for both `capturedAt` and `location`. This is, in practice, the primary way to bulk date- and geotag videos — there is no other mechanism that assigns location to a video today.

### `files[]` entries override `fallback`, per field, independently — never as a package

A `files[]` entry's *present* fields take precedence over the folder `fallback` for that file, but only for the fields the entry actually specifies. An entry with only `location` still inherits the folder's `fallback.capturedAt` for that file (if the file lacks EXIF date); an entry with only `capturedAt` still inherits `fallback.location` (if the file lacks EXIF GPS). A `files[]` entry is a scoped override, not a full replacement of the folder default for that file.

### Precedence tables

**Capture date** (highest to lowest):

| Priority | Source |
|----------|--------|
| 1 (highest) | The file's own EXIF `capturedAt` |
| 2 | A matching `files[]` entry's `capturedAt` |
| 3 | The folder's `fallback.capturedAt` |
| 4 (lowest) | If none of the above applied: the existing CLI/server best-effort file-timestamp guess (see [Bulk Import Resilience](bulk-import-resilience.md)) |

**Location** (highest to lowest):

| Priority | Source |
|----------|--------|
| 1 (highest) | The file's own EXIF GPS |
| 2 | A matching `files[]` entry's `location` |
| 3 | The folder's `fallback.location` |
| — (no lower fallback) | If none of the above applied, the item simply has no coordinates |

Note the asymmetry with capture date: there is no last-resort location guess analogous to the file-timestamp fallback. A photo with no EXIF GPS and no applicable override has no location, full stop.

---

## 5. Reverse Geocoding and coordSource

When a `memoriahub.json` fallback (folder-level or per-file) supplies coordinates for an item that lacks its own EXIF GPS, the server reverse-geocodes those coordinates into `geoCountry`, `geoAdmin1`, `geoAdmin2`, `geoLocality`, `geoPlaceName`, and `geoSource` — the same reverse-geocoding pipeline described in [Geocoding](geocoding.md), using whichever provider is currently active (`system_settings.geo.reverseProvider`). This is what makes the item appear correctly on the map and in place-based browsing (Explore > Places), exactly as if the coordinates had come from the camera's own GPS.

The server records `coordSource = 'manual'` for items whose coordinates came from a `memoriahub.json` fallback. This CLI-supplied-coordinates path is a **fourth call site** of the same `'manual'` convention already used by the pre-existing manual location edit path — as documented in [Location Inference §2](location-inference.md#2-coordinate-provenance-model), there are three writers of `coordSource`: EXIF metadata sync writes `'exif'`, `bulkUpdateMedia`'s manual location edit writes `'manual'`, and location inference writes `'inferred'` (auto-apply/unmodified-accept) or `'manual'` (adjusted accept). The CLI override path is client-supplied coordinates arriving at item-creation time rather than a later edit, but it is not machine-inferred, so it follows the existing `'manual'` convention rather than introducing a fourth `coordSource` value.

---

## 6. Validation and Error Handling

### A malformed override file is a hard stop for that folder

If `memoriahub.json` is present in a folder but is malformed in any of the following ways, the `sync` run **aborts for that invocation** with a clear error naming the offending file and the specific problem, and **uploads nothing for that folder**:

- The file is not valid, parseable JSON.
- `version` is missing, or is present but not exactly `1`.
- `location.latitude` or `location.longitude` is outside its valid range (`[-90, 90]` / `[-180, 180]`).
- `location` is present with only one of `latitude` / `longitude` (they are required together).
- Two or more entries in `files[]` share the same `name`.
- A field has the wrong type (e.g. `capturedAt` is a number, `files` is an object instead of an array).

The rationale is deliberate: a typo in a hand-edited JSON file must never silently mis-tag an entire folder's worth of photos with the wrong date or the wrong country. Failing loudly and refusing to upload anything for that folder is safer than guessing or partially applying a broken override.

### A missing override file is not an error

If a folder simply has no `memoriahub.json`, that is **not** an error condition — the folder is processed exactly as it is today, with no fallback date or location applied to any file in it. The feature is entirely additive and opt-in per folder.

---

## 7. Verifying Before You Upload

The existing pre-sync dry-run preview (`memoriahub scan` and `memoriahub sync --dry-run` — see [CLI Scan](cli-scan.md)) is extended to account for `memoriahub.json`:

- If a folder being scanned contains a `memoriahub.json`, the scan report indicates, per file, whether a date fallback and/or a location fallback from that override would be applied to it once `sync` actually runs.
- If the `memoriahub.json` in a scanned folder is malformed, the scan surfaces that problem up front — before a real `sync` run — with the same kind of specific, file-and-reason error described in [§6](#6-validation-and-error-handling), so a user can fix a typo during a fast, local, no-upload preview rather than discovering it mid-import.

> **Note:** the exact field/column names the scan report and its export (dashboard, piped table, JSON, and Excel Detail sheet — see [CLI Scan §5](cli-scan.md#5-report-and-dashboard) and [§6](cli-scan.md#6-excel-and-csv-export)) will use to represent "date fallback would apply" / "location fallback would apply" per file are **not specified here**, because this reporting integration is not yet implemented as of this writing. Whatever naming is chosen should follow the scan report's existing conventions (e.g. alongside the existing `has_exif` / `has_gps` columns) at implementation time — this document intentionally describes the behavior functionally rather than asserting a specific field name.

---

## 8. Worked Scenarios — Costa Rica 2019

A user has a folder `~/Pictures/CostaRica2019/` mixing a modern phone photo, an old scanned print, a video, and one photo that needs a specific correction. The folder's `memoriahub.json` is the example from [§3](#3-schema-reference):

```json
{
  "version": 1,
  "fallback": {
    "capturedAt": "2019-06-15T14:30:00-06:00",
    "location": { "latitude": 9.9281, "longitude": -84.0907, "altitude": 1170 }
  },
  "files": [
    { "name": "IMG_0042.jpg", "capturedAt": "2019-06-16", "location": { "latitude": 9.63, "longitude": -84.66 } }
  ]
}
```

**(a) `IMG_0501.jpg` — a modern phone photo with EXIF date and GPS already present.**
EXIF wins for both fields per [§4](#4-merge-semantics). The folder `fallback` is evaluated and simply ignored for this file — it keeps its own EXIF capture date and its own EXIF GPS untouched.

**(b) `scan-0007.jpg` — an old scanned print with no EXIF date and no EXIF GPS.**
Neither field is present in EXIF, and this file has no entry in `files[]`, so it inherits both fields from the folder `fallback`: `capturedAt = 2019-06-15T14:30:00-06:00` and the San José, Costa Rica coordinates (with `altitude = 1170`). The server reverse-geocodes those coordinates and records `coordSource = 'manual'` (per [§5](#5-reverse-geocoding-and-coordsource)).

**(c) `IMG_0512.mov` — a video.**
Videos have no EXIF at all in this pipeline, so `IMG_0512.mov` unconditionally receives both fields from the folder `fallback`, exactly like case (b) — the video is not eligible for a `files[]` override in this example only because it happens not to be listed there, not because videos are treated specially. If it had a `files[]` entry it would follow the same per-field override rule as any photo.

**(d) `IMG_0042.jpg` — a specific correction via `files[]`.**
This one photo was actually taken a day later than the rest of the trip and at a different specific location (perhaps a side excursion). Its `files[]` entry supplies both `capturedAt: "2019-06-16"` (expanded to local noon per [§3](#3-schema-reference)) and its own `location`, both of which take precedence over the folder `fallback` per [§4](#4-merge-semantics). If this entry had specified only `location` and omitted `capturedAt`, the file would have inherited the folder's `fallback.capturedAt` for its date while still getting its own corrected location.

---

## 9. Implementation Notes

This is a CLI-side feature introduced in CLI **v1.1.15**. It depends on the API accepting client-supplied fallback location fields on media creation — see [`POST /api/media`](../API.md#post-apimedia) in [API.md](../API.md), specifically the `takenLat` / `takenLng` / `takenAltitude` / `coordSource` request-body fields.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | July 2026 | AI Assistant | Initial specification |
