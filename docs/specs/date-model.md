# The Date Model — Civil Timestamps vs. Instants

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | August 2026 |
| **Status** | **Implemented** (epic #440: #442 client rendering, #443 video ingest, #444 per-user timezone, #446 range filters). Issue #445 — applying the user timezone to now-relative surfaces — is pending. |

---

## Table of Contents

1. [The Rule](#1-the-rule)
2. [Why `captured_at` Is Not an Instant](#2-why-captured_at-is-not-an-instant)
3. [Field Classification](#3-field-classification)
4. [Rendering](#4-rendering)
5. [Filtering and Range Bounds](#5-filtering-and-range-bounds)
6. [Ingest](#6-ingest)
7. [The User Timezone, and What It Does Not Touch](#7-the-user-timezone-and-what-it-does-not-touch)
8. [Testing Rules](#8-testing-rules)
9. [Known Gaps](#9-known-gaps)

---

## 1. The Rule

Every timestamp column in this codebase is `timestamptz`, and nothing in the
type distinguishes the two very different kinds of value stored in them:

| Kind | Meaning | Rendered in |
|---|---|---|
| **Civil timestamp** | The wall clock **at the place and moment of capture**, re-encoded as UTC. The `Z` is a storage costume, not a real offset. | **UTC, always** — that yields the photographer's own clock |
| **Instant** | A real point in time | The **viewer's** timezone |

> **The governing rule: a photo's date is a fact about where and when it was
> taken, not about where the viewer is standing.**

A photo shot in Tokyo must not re-file itself to a different day when its
owner travels to Miami. This is why the fix for a civil value is always to
render it in UTC — **not** to apply the user's timezone to it. Applying the
viewer's offset to a value that already encodes the capture wall clock
applies an offset a *second* time, and files a band of hours near midnight —
the width of that offset — under the wrong day.

The user timezone therefore applies to exactly two things: rendering
**instants**, and deciding what "today" / "the last N days" means for
**now-relative** queries.

---

## 2. Why `captured_at` Is Not an Instant

EXIF `DateTimeOriginal` is timezone-naive — `2026:06:20 20:16:07` with no
offset. `exifr` parses it using the *process's* local timezone, so the same
file would produce a different `getTime()` on a server in Costa Rica than on
one in UTC. Ingest therefore rebuilds the value from the wall-clock components
and stamps it `Z`
(`packages/enrichment-compute/src/metadata/index.ts`, `wallClockToCivilTimestamp`):

```ts
new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms)).toISOString();
```

A photo shot at 20:16 in Costa Rica (UTC-6) is stored `2026-06-20T20:16:07Z`,
**not** the true instant `2026-06-21T02:16:07Z`. That is deliberate and it is
what makes storage host-independent.

The genuine offset, when EXIF supplies `OffsetTimeOriginal`, is preserved
separately in `media_items.captured_at_offset` (minutes). Nothing in the
display, bucketing, or filtering paths reads it — it survives for backup
sidecars, enhancement carry-over, and DTOs.

The server is internally consistent with the civil reading: `MediaService`'s
On This Day query, every Memories curator (`curators/period-windows.ts`), and
two functional indexes all extract **UTC** parts
(`EXTRACT(... FROM captured_at AT TIME ZONE 'UTC')`).

---

## 3. Field Classification

**Civil timestamps** — render in UTC:

- `media_items.captured_at`, `media_items.original_created_at`
- `burst_groups.captured_at`, `duplicate_groups.captured_at`
- `memories.period_start`, `memories.period_end`
- Anything derived from the above (a location suggestion's `capturedAt`, a
  burst/duplicate member's `capturedAt`)

**Instants** — render in the viewer's zone:

- `created_at`, `updated_at`, `imported_at`, `deleted_at`, `archived_at`
- `started_at`, `finished_at`, `next_run_at`, `last_heartbeat_at`
- `expires_at`, `generated_at`, `read_at`, `dismissed_at`
- Every run/job/backup/token timestamp

When adding a column, ask: *is this a fact about a moment in the world, or a
reading off a clock at a particular place?* The second one is civil.

---

## 4. Rendering

### Web

`apps/web/src/utils/civilDate.ts` is the single place the civil rendering rule
lives:

| Helper | Use for |
|---|---|
| `civilDayKey(iso)` | `YYYY-MM-DD` bucket key, read in UTC |
| `formatCivilDate(iso, opts?)` | Date label, `timeZone: 'UTC'` pinned |
| `formatCivilDateTime(iso, opts?)` | Date + time (the photographer's clock) |
| `isoToCivilInput(iso)` / `civilInputToIso(value)` | `<input type="datetime-local">` in both directions |
| `instantDayKey(iso, tz?)` | The mirror helper: an **instant**'s day, viewer-local |

Locale stays browser-derived (`undefined` locale) in all of them — only the
*zone* is pinned, so a user still sees their own date order and month names.

Instants keep using plain `toLocaleString()` with no `timeZone`. Pinning an
instant to UTC is the mirror-image bug.

**`<input type="datetime-local">` is the subtle one.** It carries no zone,
which makes it the right control for a civil value — but only if both
directions read the same zone. `new Date('2026-06-20T20:16')` parses a
zone-less string as **browser local**, so the obvious
`new Date(value).toISOString()` shifts the value by the viewer's offset on
every save: opening the edit form and saving without changing anything used to
move a photo by six hours. Use `civilInputToIso`.

### Day grouping

`groupByDay` mixes the two kinds on purpose: `capturedAt` buckets in UTC,
and the `importedAt` fallback (used only for items with no capture date)
buckets in the **viewer's** zone, because an upload has no "where it was
taken". Each value lands on its own correct day; the bucket is identified by a
calendar date rather than by a zone, and its label is derived from the key so
a bucket holding both kinds cannot be labelled with a different day than it is
keyed by.

### Android

`PhotosViewModel` groups the phone's own MediaStore rows, where `DATE_TAKEN`
is a real epoch instant. Rendering that instant in the **device zone**
recovers the capture wall clock, which is the same value ingest will later
store as a civil timestamp — so it already agrees with the server. **Do not
"fix" it to UTC**; that would introduce the shift this model exists to remove.

---

## 5. Filtering and Range Bounds

`<input type="date">` yields a bare `YYYY-MM-DD` — a calendar date with no
time and no zone. Turning that into the pair of instants a range filter needs
requires knowing which kind the column holds, and the two answers differ:

| Field | Kind | "June 16" means | Bound anchored in |
|---|---|---|---|
| `capturedAt` (Date taken) | civil | June 16 on the *photographer's* calendar | **UTC** |
| `uploadedAt` → `created_at` (Upload date) | instant | June 16 on the *user's* calendar | **the user's zone** |

`apps/web/src/utils/dateRangeBounds.ts` gives each rule a name —
`civilDayRange` and `instantDayRange`. **They look almost identical and are
not interchangeable; do not unify them.** `instantDayRange` prefers the
stored user timezone (#444) and falls back to the browser zone.

### End-of-day normalisation (server side)

Some callers cannot be fixed client-side — the AI search agent emits
`YYYY-MM-DD` by design, and workflow conditions send raw calendar dates. A
bare date arrives as that day's **midnight**, and an inclusive `lte` against
it matches only an item timestamped exactly `00:00:00.000`, silently dropping
the whole final day.

`whereDateRange` and `whereCreatedAtRange`
(`apps/api/src/search/media-where.builder.ts`) therefore treat an upper bound
landing exactly on UTC midnight as **exclusive next-midnight** (`lt`).
"Exactly midnight" is a deliberate heuristic: a genuine capture at precisely
`00:00:00.000` is vanishingly rare, and the heuristic can only ever *include*
such an item, never exclude one. A bound with a real time (including the
`23:59:59.999` the web client sends) stays inclusive and is used verbatim.

Because both range builders funnel through one place, the search registry, the
agent tool, and the workflow condition compiler all inherit it.

---

## 6. Ingest

| Source | Behaviour |
|---|---|
| **Photo** (EXIF) | `DateTimeOriginal` wall clock → `wallClockToCivilTimestamp`; `OffsetTimeOriginal` → `captured_at_offset` |
| **Video**, container states local time + offset | Same re-encode, from `com.apple.quicktime.creationdate` or `date`; the offset is recorded |
| **Video**, bare UTC `creation_time` only | Stored as the instant, `captured_at_offset` left null, logged at debug |

The third row is the honest gap: MP4/MOV spec `creation_time` as UTC, so a
container that writes only that carries no local information at all. The
capture zone is unknowable, and guessing one (the server's zone, the circle
owner's zone) would be worse than a known-imperfect value. Such a video may
bucket on the neighbouring calendar day, and **a re-run cannot fix it** —
the information was never in the file.

The wall-clock re-encode is one shared helper in
`packages/enrichment-compute/src/metadata`, used by both ingest paths, so they
cannot drift and both executors (the API and a worker node) produce identical
values.

---

## 7. The User Timezone, and What It Does Not Touch

`user_settings.timezone` (issue #444) is a per-user IANA zone name.
`GET /api/auth/me` and `GET /api/user-settings` surface the **raw** stored
value — `null` when the user has never expressed a preference, never resolved
to `'UTC'` — so a client can tell "chose UTC" from "never chose" and decide
whether to prompt. Server-side consumers resolve it through
`UserTimeZoneService`, which fail-opens to `'UTC'`.

It governs:

- rendering **instants**
- **now-relative** queries: what "today" and "the last N days" mean

It does **not** govern `captured_at`, in any surface, ever.

**The user timezone changes no SQL `EXTRACT` expression.** Because
`captured_at` is already civil-in-UTC, On This Day keeps extracting UTC parts
and the functional indexes (`20260615000000_media_oncethisday_index`,
`20260809140000_memories_on_this_day_index`) stay valid. What changes is only
*which* month/day integers JavaScript passes in: the civil parts of "now" in
the user's zone, rather than `now.getUTCMonth()/getUTCDate()`. That is issue
#445.

---

## 8. Testing Rules

**A test for any of this is meaningless under `TZ=UTC`.** The buggy
browser-local reading and the correct UTC reading produce identical output in
UTC, so the defect is invisible. CI pins no zone, and this container's default
resolves to UTC-equivalent.

Every such test must therefore set `process.env.TZ` explicitly, and should run
the same fixture under **two zones with opposite-signed offsets** —
`America/Costa_Rica` (UTC-6, no DST) and `Asia/Kolkata` (UTC+5:30) are the
pair used by `apps/web/src/__tests__/utils/civilDate.test.ts` and
`dateRangeBounds.test.ts` — so a regression in either direction fails. Node
re-reads `process.env.TZ` at runtime, so a per-case swap works.

Boundary fixtures worth keeping: `00:30`, `02:00`, `12:00`, `23:30`.

---

## 9. Known Gaps

- **Videos with only a bare UTC `creation_time`** keep an instant in a civil
  column (§6). Not recoverable.
- **Photos ingested without `OffsetTimeOriginal`** have no recorded capture
  offset. The civil timestamp is still correct — the offset is simply unknown.
- **`media_items.captured_at_offset` is never read** by display, bucketing, or
  filtering. It is available if a future feature wants to show "20:16 UTC-6".
- **No provenance flag distinguishes a manually corrected `captured_at`** from
  an ingested one, so `POST /api/admin/metadata/backfill` will overwrite a
  user's hand-set capture date with whatever the file says. Worth resolving
  before running a large backfill.
- **Deriving an IANA zone from GPS coordinates** is not done.
  `offline-geo-location.provider.ts` declares an unused optional `timezone?`
  field; populating it would let a photo state its own capture zone rather
  than only its offset.
- **Issue #445** — applying the user timezone to On This Day, workflow
  relative-date conditions, and the digest send hour — is not yet implemented.
