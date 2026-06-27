# Geocoding — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
| **Status** | Specification |

---

## Table of Contents

1. [Overview and Goals](#1-overview-and-goals)
2. [Provider Model](#2-provider-model)
3. [Architecture](#3-architecture)
4. [Credential Management and Encryption](#4-credential-management-and-encryption)
5. [Data Model](#5-data-model)
6. [API Endpoints](#6-api-endpoints)
7. [Backfill Semantics](#7-backfill-semantics)
8. [Privacy Implications](#8-privacy-implications)
9. [Testing Notes](#9-testing-notes)

---

## 1. Overview and Goals

Reverse geocoding converts GPS coordinates (latitude / longitude) stored on a media item into human-readable location fields (`geoCountry`, `geoAdmin1`, `geoAdmin2`, `geoLocality`, `geoPlaceName`, `geoSource`, `geocodedAt`). These fields power location-based search, place exploration, and the "Explore > Places" view.

Before this feature, the active reverse-geocoding provider was a static environment variable (`GEO_PROVIDER`). This feature adds:

- **Google Maps** as a third reverse-geocoding provider alongside the existing `offline` (GeoNames dataset) and `nominatim` (OSM Nominatim HTTP) options.
- **In-app provider selection**: admins choose the active reverse provider via a new Geo Settings admin page. The selection is persisted in `system_settings` under `geo.reverseProvider` and takes effect without a restart.
- **Encrypted credential store** for the Google API key, matching the pattern used by AI and face provider credentials.
- **`geocode` enrichment job type**: a dedicated handler that re-reads stored GPS from `media_items` (no image download required) and writes geo columns, with per-item status tracked in `media_geocode_status`.
- **App-wide backfill**: an admin endpoint that re-geocodes all media items with GPS coordinates across all circles, not scoped to a single circle.

### Non-Goals

- Per-circle opt-in is not implemented. Geocoding is a global provider selection.
- The `geocode` enrichment handler is not enqueued automatically at upload time — geocoding happens via the existing storage processing pipeline (`geocode` processor inside `metadata_extraction`). This feature provides on-demand rerun and admin-level backfill only.
- Forward geocoding (`GET /api/media/geo/search`) is not affected by this feature; it uses its own provider selection via `GEO_FORWARD_PROVIDER`.

---

## 2. Provider Model

Three providers are supported for reverse geocoding:

| Provider | Key | GPS leaves server? | Requires credential |
|----------|-----|--------------------|---------------------|
| GeoNames offline dataset | `offline` | No | No (bundled) |
| OSM Nominatim HTTP API | `nominatim` | Yes (to OSM) | No |
| Google Maps Geocoding API | `google` | Yes (to Google) | Yes (API key, encrypted in DB) |

### Provider Selection

The active provider is resolved at runtime by `GeoLocationService.reverseGeocode`:

1. Read `system_settings.geo.reverseProvider` (set via `PUT /api/geo/features/reverse`).
2. Fall back to the `GEO_PROVIDER` environment variable if the system setting is absent.
3. Default to `offline` if neither is set.

When `google` is the active provider, the service fetches the encrypted API key from `geo_provider_credentials`, decrypts it, and passes it to `GoogleGeoLocationProvider.reverseGeocodeWithKey`. If the credential is missing or disabled, the service logs a warning and falls back to `offline` transparently — no error is returned to the caller.

### `offline` Provider

Uses the `local-reverse-geocoder` npm package with a bundled GeoNames dataset. Processing is entirely in-process; no network call is made and GPS coordinates never leave the server. This is the privacy-safe default.

#### Admin1 (state/region) resolution

The `local-reverse-geocoder` library does not always expand the admin1 code into a human-readable name — some US states (e.g., California) were stored with a null `geoAdmin1` while others the library happened to resolve natively (e.g., Texas) were populated correctly. The provider in `apps/api/src/media/geo/offline-geo-location.provider.ts` applies a deterministic fallback using a bundled 56-entry map in `apps/api/src/media/geo/us-state-codes.ts` (50 US states + DC + 5 territories, keyed by USPS abbreviation):

1. Use `admin1Name` if the library populated it.
2. If `admin1Name` is absent and the country code is `US`, resolve `admin1Code` (e.g., `"CA"`) to the full state name via the map (e.g., `"California"`).
3. If the item is not US-based, fall back to the raw `admin1Code` string rather than null.
4. If `admin1Code` is also absent, `geoAdmin1` remains null.

This ensures consistent `geoAdmin1` values across all US media regardless of which states the GeoNames dataset resolves natively.

> **Operational note — items geocoded before this fix:** Existing records keep their stored `geoAdmin1` (which may be null for affected US states) until they are re-geocoded. To repopulate region data across the full library, run `POST /api/admin/geocode/backfill` with `{ "force": true }`. You may also clear the GeoNames cache directory (`GEONAMES_CACHE_DIR`, default `/tmp/geonames-cache`) and restart the API to ensure the in-process dataset is refreshed before the backfill runs.

### `nominatim` Provider

Sends GPS coordinates to the OSM Nominatim HTTP API. The default endpoint is `https://nominatim.openstreetmap.org`, overridable with `NOMINATIM_BASE_URL`. GPS leaves the server on each request.

### `google` Provider

Calls `https://maps.googleapis.com/maps/api/geocode/json?latlng={lat},{lng}&key={apiKey}`. Requires a billing-enabled Google Cloud project with the Geocoding API enabled. GPS coordinates are sent to Google on every geocode call. The API key is stored encrypted in the database and never returned in plaintext by any endpoint.

---

## 3. Architecture

### 3.1 `GeoLocationService` (Dynamic Resolution)

`GeoLocationService` (`apps/api/src/media/geo/geo-location.service.ts`) is the single entry point for all reverse geocoding calls within the application. It resolves the active provider on every call by reading system settings, ensuring that an admin can switch providers and the change applies immediately to all subsequent jobs without a restart.

### 3.2 Enrichment Job Type: `geocode`

`geocode` is a job type in the `enrichment_jobs` queue, handled by `GeocodeHandler` (`apps/api/src/geo/geocode.handler.ts`). It self-registers with `EnrichmentHandlerRegistry` via `onModuleInit`.

**Processing flow:**

1. Load `MediaItem` by `mediaItemId`. If the item is missing, deleted, or has no `takenLat`/`takenLng`, mark status appropriately and return early.
2. Upsert `media_geocode_status` to `processing`.
3. Call `GeoLocationService.reverseGeocode(takenLat, takenLng)` — provider is resolved dynamically.
4. If a result is returned, write `geoCountry`, `geoCountryCode`, `geoAdmin1`, `geoAdmin2`, `geoLocality`, `geoPlaceName`, `geoSource`, and `geocodedAt` directly to `media_items`.
5. Upsert `media_geocode_status` to `processed`.

On any uncaught error, mark status `failed` with `lastError` and re-throw so the worker applies standard retry logic.

**Priority conventions:**

| Trigger | `reason` | `priority` |
|---------|----------|------------|
| Per-item rerun (user/admin) | `rerun` | 0 (highest) |
| Backfill | `backfill` | 100 (lowest) |

No `upload` reason exists — the geocode handler is not enqueued at upload time.

For worker lifecycle, retry configuration, and queue architecture see [enrichment-queue.md](enrichment-queue.md).

### 3.3 Module Wiring

`GeoModule` (`apps/api/src/geo/geo.module.ts`) registers `GeoSettingsController`, `GeocodeAdminController`, `GeocodeMediaController`, `GeoSettingsService`, `GeocodeBackfillService`, and `GeocodeHandler`. It imports `MediaGeoLocationModule` (which provides the three provider implementations and `GeoLocationService`) and the `EnrichmentModule`.

---

## 4. Credential Management and Encryption

Google API keys are stored in the `geo_provider_credentials` table using AES-256-GCM encryption via `SECRETS_ENCRYPTION_KEY` — the same key used for AI and face provider credentials. The same helper functions (`encryptSecret` / `decryptSecret` from `apps/api/src/common/crypto/secret-cipher.ts`) are used throughout.

**What is stored and returned:**

| Field | Stored | API response |
|-------|--------|--------------|
| Full API key | Encrypted (`encrypted_key` column) | Never |
| Last 4 characters | Plaintext (`last4` column) | Yes (`last4` field) |
| Base URL override | Plaintext (`base_url` column) | Yes |
| Enabled flag | Plaintext | Yes |

`SECRETS_ENCRYPTION_KEY` must be set at startup. The API fails to start if the variable is missing or incorrectly sized. See [SECURITY.md](../SECURITY.md) for key generation instructions.

**Constraint:** only the `google` provider key is currently supported. Attempting `PUT /api/geo/credentials/other` returns `400 Bad Request`.

---

## 5. Data Model

### 5.1 New Table: `geo_provider_credentials`

One row per provider. Currently only `google` is supported.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `provider` | String | Unique; currently only `'google'` |
| `encrypted_key` | String | AES-256-GCM encrypted API key |
| `base_url` | String? | Optional endpoint override |
| `last4` | String | Last 4 chars of the plaintext key; for display only |
| `enabled` | Boolean | Default `true`; set `false` to disable without deleting |
| `updated_by_user_id` | UUID? | FK → `users` (SetNull on delete) |
| `created_at` | Timestamptz | |
| `updated_at` | Timestamptz | |

### 5.2 New Table: `media_geocode_status`

One row per media item. Tracks the status of the most recent `geocode` enrichment job for that item.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `media_item_id` | UUID | FK → `media_items` (cascade delete); unique — one row per item |
| `circle_id` | UUID | FK → `circles` (cascade delete); denormalized for indexed queries |
| `status` | `MediaMetadataStatusType` | Reuses existing enum; see below |
| `processed_at` | Timestamptz? | Set when status transitions to `processed` |
| `last_error` | String? | Set when status transitions to `failed` |
| `created_at` | Timestamptz | |
| `updated_at` | Timestamptz | |

**`MediaMetadataStatusType` values used by geocoding:**

| Value | Meaning |
|-------|---------|
| `not_processed` | No geocode job has run (virtual — the API returns this when no row exists) |
| `pending` | Job enqueued, not yet picked up |
| `processing` | Worker claimed and started the job |
| `processed` | Geocoding completed; geo columns updated |
| `failed` | Processing failed; see `lastError` for details |

**Indexes:**

- Unique on `media_item_id`
- Index on `circle_id`
- Index on `status`

### 5.3 `system_settings` Key: `geo.reverseProvider`

The active reverse-geocoding provider is stored in the `system_settings` JSONB column under path `geo.reverseProvider`. Valid values are `'offline'`, `'nominatim'`, and `'google'`. This key is written by `PUT /api/geo/features/reverse` and read by `GeoLocationService` on every geocode call.

---

## 6. API Endpoints

All endpoints require JWT Bearer authentication. Geo settings endpoints require the Admin system role plus the relevant `geo_settings:*` permission.

### 6.1 Get Geo Settings

#### `GET /api/geo/settings`

Returns configured provider credentials (masked) and the active reverse provider.

- **Auth:** Admin + `geo_settings:read`
- **Response `200`:**
  ```json
  {
    "providers": [
      {
        "provider": "google",
        "configured": true,
        "enabled": true,
        "last4": "ab12",
        "baseUrl": null
      }
    ],
    "activeReverseProvider": "google"
  }
  ```
  `activeReverseProvider` is resolved from `system_settings.geo.reverseProvider`, falling back to `GEO_PROVIDER` env, then `"offline"`.

### 6.2 Upsert Provider Credentials

#### `PUT /api/geo/credentials/:provider`

Configure (or update) credentials for a geo provider. Currently only `google` is supported.

- **Auth:** Admin + `geo_settings:write`
- **Path param:** `provider` — must be `google`; other values return `400`
- **Request body:**
  ```json
  {
    "apiKey": "AIza...",
    "baseUrl": null,
    "enabled": true
  }
  ```
  `baseUrl` and `enabled` are optional. `enabled` defaults to `true` on create.
- **Response `200`:**
  ```json
  {
    "provider": "google",
    "configured": true,
    "enabled": true,
    "last4": "ab12",
    "baseUrl": null
  }
  ```

### 6.3 Delete Provider Credentials

#### `DELETE /api/geo/credentials/:provider`

Remove credentials for a provider. Returns `404` if no credential is configured.

- **Auth:** Admin + `geo_settings:write`
- **Response `200`:** `{ "deleted": true, "provider": "google" }`
- **Response `404`:** No credential found for the given provider.

### 6.4 Set Active Reverse Provider

#### `PUT /api/geo/features/reverse`

Set the active reverse-geocoding provider. Persists to `system_settings.geo.reverseProvider`. Takes effect immediately on the next geocode call.

- **Auth:** Admin + `geo_settings:write`
- **Request body:** `{ "provider": "offline" | "nominatim" | "google" }`
- **Response `200`:** `{ "reverseProvider": "google" }`
- **Response `400`:** If `provider` is `google` but no enabled credential is configured.

### 6.5 Test Provider Connectivity

#### `POST /api/geo/test`

Test a provider using an optional lat/lng pair. Defaults to San José, Costa Rica (`9.9281, -84.0907`) if coordinates are omitted.

- **Auth:** Admin + `geo_settings:read`
- **Request body:**
  ```json
  {
    "provider": "offline" | "nominatim" | "google",
    "lat": 9.9281,
    "lng": -84.0907
  }
  ```
- **Response `200` — success:**
  ```json
  {
    "ok": true,
    "sample": {
      "country": "Costa Rica",
      "locality": "San José",
      "placeName": "San José, San José Province, Costa Rica"
    }
  }
  ```
- **Response `200` — failure:** `{ "ok": false, "error": "description" }`

### 6.6 App-Wide Geocode Backfill (Admin)

#### `POST /api/admin/geocode/backfill`

Bulk-enqueue `geocode` enrichment jobs for all media items with GPS coordinates across all circles. Scoped to items where `takenLat` and `takenLng` are non-null. No circle membership check — this is an admin-level operation.

- **Auth:** Admin + `geo_settings:write`
- **Request body:**
  ```json
  {
    "from": "2025-01-01T00:00:00.000Z",
    "to": "2025-12-31T23:59:59.999Z",
    "force": false
  }
  ```
  `from` and `to` are optional ISO-8601 datetime strings bounding `capturedAt`. `force` defaults to `false`. See [§7 Backfill Semantics](#7-backfill-semantics).
- **Response `201`:**
  ```json
  { "enqueued": 483 }
  ```

### 6.7 Per-Item Geocode Rerun

#### `POST /api/media/:id/geocode/rerun`

Re-enqueue geocoding for a single media item.

- **Auth:** `media:write` + per-circle `collaborator` role (or `media:write_any` for admin bypass)
- **Response `201`:**
  ```json
  {
    "data": {
      "jobId": "uuid",
      "status": "pending"
    }
  }
  ```
  Job is enqueued at priority 0. `media_geocode_status` is upserted to `pending` immediately.
- **Response `404`:** Item not found or soft-deleted.

### 6.8 Per-Item Geocode Status

#### `GET /api/media/:id/geocode/status`

Get the current geocoding status for a single media item.

- **Auth:** `media:read` + per-circle `viewer` role (or `media:read_any` for admin bypass)
- **Response `200`:**
  ```json
  {
    "data": {
      "status": "processed",
      "processedAt": "2026-06-21T10:30:00.000Z",
      "lastError": null
    }
  }
  ```
  When no `media_geocode_status` row exists, `status` is `"not_processed"` and `processedAt`/`lastError` are `null`.
- **Response `404`:** Item not found or soft-deleted.

---

## 7. Backfill Semantics

The backfill endpoint (`POST /api/admin/geocode/backfill`) is app-wide — it queries across all circles, not a single circle. This distinguishes it from other backfill endpoints (tagging, face detection, burst, metadata) which are scoped by `circleId`.

Candidate selection applies the following filters in combination:

1. **Not deleted:** `deletedAt IS NULL`.
2. **Has GPS:** `takenLat IS NOT NULL AND takenLng IS NOT NULL`.
3. **Date range (optional):** when `from` or `to` is provided, `capturedAt` is bounded by the given range (inclusive). Items with null `capturedAt` are excluded when a bound is specified.
4. **Force flag:**
   - `force = false` (default): only items whose `media_geocode_status` row is absent OR whose status is not `processed` are enqueued. Items that have already been successfully geocoded are skipped.
   - `force = true`: all non-deleted items with GPS in scope are enqueued regardless of existing status. Use this after switching providers to re-geocode the entire library with the new provider.

For each selected item, the endpoint:
- Calls `EnrichmentJobService.enqueue` with `type='geocode'`, `reason=backfill`, `priority=100`.
- Upserts `media_geocode_status` to `pending`.

The `enqueued` response reflects the number of jobs successfully submitted.

---

## 8. Privacy Implications

Reverse geocoding can involve sending GPS coordinates to third-party services depending on the active provider. Admins should select a provider that matches their privacy requirements.

| Provider | GPS sent to | Privacy |
|----------|-------------|---------|
| `offline` | Nobody — processing is in-process | Full GPS privacy |
| `nominatim` | OpenStreetMap Nominatim (`nominatim.openstreetmap.org` by default, overridable with `NOMINATIM_BASE_URL`) | GPS leaves server to OSM |
| `google` | Google Maps Geocoding API (`maps.googleapis.com`) | GPS leaves server to Google; billing account required |

The `GET /api/geo/settings` response includes the `activeReverseProvider` so admins can audit the current selection at any time.

**The `GET /api/geo/test` endpoint sends a single geocoding request to the chosen provider using the provided (or default) coordinates.** Admins should be aware that calling the test endpoint with `provider: "nominatim"` or `provider: "google"` will send the test coordinates to the respective third party.

Forward geocoding (`GET /api/media/geo/search`) is a separate feature and uses `GEO_FORWARD_PROVIDER` / `GEO_FORWARD_SEARCH_ENABLED`. It sends only the typed place-name query — never GPS coordinates.

---

## 9. Testing Notes

### Unit Tests

- **`GeoLocationService.reverseGeocode`:** mock `SystemSettingsService` to return each of the three provider keys and verify the correct underlying provider is called; verify fallback to `offline` when Google credential is missing or disabled.
- **`GeocodeHandler.process`:** verify status transitions (`pending → processing → processed`), geo column writes, and `geoSource` is set correctly; verify that a missing item sets status to `failed` without throwing; verify that an item with null GPS is marked `processed` with no geo column update.
- **`GeoSettingsService.setActiveReverseProvider`:** verify it rejects `google` when no enabled credential exists; verify it persists the value via `SystemSettingsService.patchSettings`.
- **`GoogleGeoLocationProvider`:** mock `fetch` to return `ZERO_RESULTS`, `REQUEST_DENIED`, and a valid result; verify returned `GeoLocationResult` fields are mapped correctly.

### Integration Tests

- **Full pipeline:** enqueue a `geocode` job and verify `media_geocode_status` transitions through `pending → processing → processed` and that geo columns on `media_items` are populated.
- **No GPS:** enqueue a `geocode` job for an item with null `takenLat`/`takenLng`; verify status becomes `processed` and no geo columns are modified.
- **Backfill — force=false:** seed items with `status=processed` and items with no status row; call backfill; verify only unprocessed items are enqueued.
- **Backfill — force=true:** call backfill with `force=true`; verify all non-deleted GPS items are enqueued regardless of existing status.
- **Credential flow:** upsert credential, verify `last4` is stored and plaintext key is not returned by `GET /api/geo/settings`.
- **Provider switch to google — no credential:** call `PUT /api/geo/features/reverse` with `{ provider: "google" }` when no credential exists; verify `400` response.

### RBAC Tests

- Verify non-admin users receive `403` on all `/api/geo/*` endpoints.
- Verify a `viewer` can call `GET /api/media/:id/geocode/status` but receives `403` on `POST /api/media/:id/geocode/rerun`.
- Verify a `collaborator` can call `POST /api/media/:id/geocode/rerun`.
- Verify a non-member receives `403` on per-item endpoints.

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | AI Assistant | Initial specification |
