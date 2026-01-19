# Reverse Geocoding Implementation Plan

## Overview

This plan implements the reverse geocoding worker job handler based on the specification in [REVERSE_GEOCODE_SPEC.md](REVERSE_GEOCODE_SPEC.md). The implementation follows the existing handler patterns in the codebase and moves geocoding to async processing for better UX.

---

## Phase 1: Move Geocoding Service to Shared Package

### Task 1.1: Create Shared Geocoding Service

**File:** `packages/shared/src/services/geocoding.service.ts`

**Actions:**
- Copy the geocoding service from `apps/api/src/services/media/geocoding.service.ts`
- Keep all existing functionality (caching, rate limiting, coordinate validation)
- Export the singleton instance and types
- Ensure it works in both API and worker contexts

**Key Implementation Details:**
- In-memory cache with 24-hour TTL, 10k max entries
- Rate limiting: 1.1 second minimum between requests (Nominatim ToS)
- Coordinate rounding to 4 decimal places (~11m precision)
- Returns `GeocodingResult` type (already defined in shared types)

### Task 1.2: Create Services Index Export

**File:** `packages/shared/src/services/index.ts`

**Actions:**
- Create barrel export for services
- Export `geocodingService` singleton and `GeocodingService` class

### Task 1.3: Update Shared Package Exports

**File:** `packages/shared/src/index.ts`

**Actions:**
- Add export for services: `export * from './services/index.js'`

### Task 1.4: Update API Geocoding Service (Backwards Compatibility)

**File:** `apps/api/src/services/media/geocoding.service.ts`

**Actions:**
- Replace implementation with re-export from shared package
- Maintain backwards compatibility for existing API imports

---

## Phase 2: Worker Handler Implementation

### Task 2.1: Add Geocoding Log Event Types

**File:** `apps/worker/src/infrastructure/logging/logger.ts`

**Actions:**
- Add to `LogEventTypes` enum:
  - `GEOCODING_STARTED: 'geocoding.started'`
  - `GEOCODING_COMPLETED: 'geocoding.completed'`
  - `GEOCODING_NO_RESULTS: 'geocoding.no_results'`
  - `GEOCODING_SKIPPED: 'geocoding.skipped'`

### Task 2.2: Add Repository Method for Location Updates

**File:** `apps/worker/src/repositories/media-asset.repository.ts`

**Actions:**
- Add `LocationUpdate` interface
- Add `updateLocation(assetId: string, location: LocationUpdate): Promise<void>` method
- Follow existing pattern with parameterized query and logging

**Implementation:**
```typescript
interface LocationUpdate {
  country: string | null;
  state: string | null;
  city: string | null;
  locationName: string | null;
}

async updateLocation(assetId: string, location: LocationUpdate): Promise<void> {
  await query(
    `UPDATE media_assets
     SET country = $1, state = $2, city = $3, location_name = $4, updated_at = NOW()
     WHERE id = $5`,
    [location.country, location.state, location.city, location.locationName, assetId]
  );
}
```

### Task 2.3: Create Reverse Geocode Handler

**File:** `apps/worker/src/handlers/reverse-geocode.handler.ts`

**Actions:**
- Extend `BaseHandler`
- Set `jobType = 'reverse_geocode'`
- Implement `process(context: JobContext)` method

**Handler Logic:**
1. Get asset using `this.getAsset(context)`
2. Check for GPS coordinates - skip if missing (not an error)
3. Check if already geocoded - skip if location data exists
4. Call `geocodingService.reverseGeocode(lat, lon)`
5. Update asset with `mediaAssetRepository.updateLocation()`
6. Return result with location data and duration

**Skip Conditions (return `skipped: true`, not error):**
- No GPS coordinates (`latitude` or `longitude` is null)
- Already geocoded (`country` or `city` is not null)

**Error Handling:**
- Geocoding API errors → throw (will retry with backoff)
- Database errors → throw (will retry with backoff)
- Asset not found → throw (handler should fail)

### Task 2.4: Export Handler

**File:** `apps/worker/src/handlers/index.ts`

**Actions:**
- Add import for `ReverseGeocodeHandler`
- Add export for `ReverseGeocodeHandler`
- Export singleton instance `reverseGeocodeHandler`

### Task 2.5: Register Handler

**File:** `apps/worker/src/index.ts`

**Actions:**
- Import `reverseGeocodeHandler` from handlers
- Register in `registerHandlers()` function: `jobRouter.register(reverseGeocodeHandler)`

---

## Phase 3: Update Upload Service to Queue Job

### Task 3.1: Add Reverse Geocode Job to Queue

**File:** `apps/api/src/services/upload/upload.service.ts`

**Actions:**
- Update `queueProcessingJobs()` method to include `reverse_geocode` job
- Set priority to 3 (lower than thumbnail at 10, preview at 5)
- Use `default` queue

**Updated Method:**
```typescript
private async queueProcessingJobs(assetId: string, traceId: string | null): Promise<void> {
  await processingJobRepository.createMany([
    { assetId, jobType: 'generate_thumbnail', priority: 10, traceId },
    { assetId, jobType: 'generate_preview', priority: 5, traceId },
    { assetId, jobType: 'reverse_geocode', priority: 3, traceId },
  ]);
}
```

### Task 3.2: Remove Synchronous Geocoding from Upload

**File:** `apps/api/src/services/upload/upload.service.ts`

**Actions:**
- Remove synchronous geocoding call from `completeUpload()` (around lines 234-240)
- Remove synchronous geocoding call from `proxyUpload()` (around lines 361-365)
- Keep GPS coordinate extraction (latitude/longitude from EXIF) - only remove the geocoding API call

**Note:** The EXIF extraction that gets lat/lon from metadata should remain - we only remove the synchronous Nominatim API call that converts coordinates to location names.

---

## Phase 4: Testing

### Task 4.1: Create Handler Unit Tests

**File:** `apps/worker/tests/unit/handlers/reverse-geocode.handler.test.ts`

**Test Cases:**

**Success Scenarios:**
1. ✅ Successfully geocodes asset with GPS coordinates
2. ✅ Updates database with full location data (country, state, city, locationName)
3. ✅ Updates database with partial location data (only country available)
4. ✅ Returns correct result structure with duration

**Skip Scenarios:**
5. ✅ Skips when asset has no latitude
6. ✅ Skips when asset has no longitude
7. ✅ Skips when asset already has country populated
8. ✅ Skips when asset already has city populated
9. ✅ Returns `skipped: true` with appropriate reason

**Edge Cases:**
10. ✅ Handles geocoding returning empty results (no error, just no data)
11. ✅ Logs appropriate events for all scenarios

**Error Scenarios:**
12. ✅ Throws when asset not found (job should fail)
13. ✅ Throws when geocoding service errors (for retry)
14. ✅ Throws when database update fails (for retry)

**Mocking Strategy:**
- Mock `mediaAssetRepository.findById` and `mediaAssetRepository.updateLocation`
- Mock `geocodingService.reverseGeocode`
- Create helper functions for mock job context and assets

### Task 4.2: Create Repository Method Tests

**File:** `apps/worker/tests/unit/repositories/media-asset.repository.test.ts`

**Test Cases:**
1. ✅ `updateLocation` executes correct SQL with all parameters
2. ✅ `updateLocation` handles null values correctly
3. ✅ `updateLocation` handles partial location data

### Task 4.3: Verify Shared Service Tests (if moving service)

**File:** `packages/shared/tests/services/geocoding.service.test.ts` (optional)

**Note:** The existing geocoding service tests in the API should continue to work. If tests exist there, consider:
- Moving them to shared package, OR
- Keeping API tests that import from shared

---

## Phase 5: Verification & Cleanup

### Task 5.1: Run Type Checks

```bash
npm run typecheck
```

Verify no TypeScript errors across all packages.

### Task 5.2: Run All Tests

```bash
npm run test -- --run
```

Verify all existing tests still pass plus new tests.

### Task 5.3: Manual Testing

1. Start services: `.\scripts\dev.ps1 start`
2. Upload a photo with GPS coordinates
3. Verify `reverse_geocode` job appears in database
4. Verify worker processes the job
5. Verify location data populated on asset
6. Upload a photo without GPS coordinates
7. Verify job completes with `skipped: true`

### Task 5.4: Verify Observability

- Check Grafana for new job metrics
- Check Jaeger for geocoding spans
- Check Loki for geocoding log events

---

## Implementation Order Summary

| Order | Phase | Task | Files |
|-------|-------|------|-------|
| 1 | 1.1 | Create shared geocoding service | `packages/shared/src/services/geocoding.service.ts` |
| 2 | 1.2 | Create services index | `packages/shared/src/services/index.ts` |
| 3 | 1.3 | Update shared exports | `packages/shared/src/index.ts` |
| 4 | 1.4 | Update API geocoding (re-export) | `apps/api/src/services/media/geocoding.service.ts` |
| 5 | 2.1 | Add log event types | `apps/worker/src/infrastructure/logging/logger.ts` |
| 6 | 2.2 | Add repository method | `apps/worker/src/repositories/media-asset.repository.ts` |
| 7 | 2.3 | Create handler | `apps/worker/src/handlers/reverse-geocode.handler.ts` |
| 8 | 2.4 | Export handler | `apps/worker/src/handlers/index.ts` |
| 9 | 2.5 | Register handler | `apps/worker/src/index.ts` |
| 10 | 3.1 | Queue job in upload | `apps/api/src/services/upload/upload.service.ts` |
| 11 | 3.2 | Remove sync geocoding | `apps/api/src/services/upload/upload.service.ts` |
| 12 | 4.1 | Handler tests | `apps/worker/tests/unit/handlers/reverse-geocode.handler.test.ts` |
| 13 | 4.2 | Repository tests | `apps/worker/tests/unit/repositories/media-asset.repository.test.ts` |
| 14 | 5.x | Verification | Run typecheck, tests, manual testing |

---

## Files Summary

### New Files (4)
| File | Description |
|------|-------------|
| `packages/shared/src/services/geocoding.service.ts` | Geocoding service moved to shared |
| `packages/shared/src/services/index.ts` | Services barrel export |
| `apps/worker/src/handlers/reverse-geocode.handler.ts` | Handler implementation |
| `apps/worker/tests/unit/handlers/reverse-geocode.handler.test.ts` | Handler tests |

### Modified Files (7)
| File | Changes |
|------|---------|
| `packages/shared/src/index.ts` | Export services |
| `apps/api/src/services/media/geocoding.service.ts` | Re-export from shared |
| `apps/api/src/services/upload/upload.service.ts` | Add job to queue, remove sync geocoding |
| `apps/worker/src/handlers/index.ts` | Export new handler |
| `apps/worker/src/index.ts` | Register handler |
| `apps/worker/src/repositories/media-asset.repository.ts` | Add `updateLocation` method |
| `apps/worker/src/infrastructure/logging/logger.ts` | Add geocoding event types |

---

## Acceptance Criteria

- [ ] Reverse geocode job processes successfully for assets with GPS coordinates
- [ ] Job is skipped (not failed) for assets without GPS coordinates
- [ ] Job is skipped for assets that already have location data
- [ ] Location data (country, state, city, locationName) is persisted to database
- [ ] Job appears in admin dashboard with correct status
- [ ] Geocoding cache prevents duplicate API calls
- [ ] Failed jobs retry with exponential backoff
- [ ] All operations logged with traceId
- [ ] Upload response time improved (geocoding moved to background)
- [ ] All tests pass (`npm run typecheck && npm run test -- --run`)
- [ ] Unit tests achieve 80%+ coverage for new code

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Breaking existing geocoding during migration | Re-export from shared maintains backwards compatibility |
| Rate limiting issues during backfill | Use existing 1.1s rate limit; backfill has lower priority |
| Failed jobs piling up | Existing exponential backoff (30s base, 1hr max) handles this |
| Nominatim API unavailable | Jobs will retry; assets work without location data |

---

## Not In Scope (Future Work)

- Metrics histograms for geocoding (spec mentions but not critical for MVP)
- Configuration for enabling/disabling geocoding
- Force re-geocode flag for manual re-processing
- Backfill script for existing assets without location data
- Admin API endpoint for backfill triggering
