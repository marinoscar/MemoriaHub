# Reverse Geocoding Job Specification

## Overview

Implement a worker job handler for reverse geocoding that converts GPS coordinates (latitude/longitude) from media assets into human-readable location information (Country, State, City, Location Name).

## Current State Analysis

### What Exists

1. **Job Type Defined**: `reverse_geocode` is already defined in `packages/shared/src/types/media.types.ts`
2. **Database Schema Ready**: `media_assets` table has location columns:
   - `latitude` NUMERIC(10, 7)
   - `longitude` NUMERIC(10, 7)
   - `country` VARCHAR(100)
   - `state` VARCHAR(100)
   - `city` VARCHAR(100)
   - `location_name` VARCHAR(255)
3. **Geocoding Service**: `GeocodingService` exists in `apps/api/src/services/media/geocoding.service.ts`:
   - Uses OpenStreetMap Nominatim API (free, no API key required)
   - Built-in caching (24-hour TTL, 10k entries)
   - Rate limiting (1 request/second per Nominatim ToS)
4. **Processing Job Infrastructure**: Complete (DB, repository, router, context)
5. **Handler Base Class**: `BaseHandler` with common utilities

### What's Missing

1. `ReverseGeocodeHandler` class in worker service
2. Geocoding service in worker service (currently only in API)
3. Media asset repository method to update location fields
4. Handler registration
5. Job queuing logic (when to create the job)
6. Tests

## Design Decisions

### Decision 1: Service Location

**Option A**: Copy `GeocodingService` to worker (duplication)
**Option B**: Move `GeocodingService` to `packages/shared` (shared library)
**Option C**: Keep in API, call via internal HTTP

**Recommendation**: **Option B** - Move to shared package
- Avoids code duplication
- Both API (upload flow) and worker can use it
- Maintains single source of truth for caching logic

### Decision 2: When to Queue Reverse Geocode Jobs

**Current Flow:**
```
Upload → EXIF Extraction (sync) → Geocoding (sync) → METADATA_EXTRACTED → Queue derivative jobs
```

**Issue**: Geocoding runs synchronously during upload, blocking the response.

**Proposed Flow:**
```
Upload → EXIF Extraction (sync) → METADATA_EXTRACTED → Queue ALL jobs (thumbnail, preview, reverse_geocode)
```

**Benefits**:
- Faster upload response (no geocoding API call during request)
- Retry support for failed geocoding
- Better observability (job metrics, traces)
- Graceful degradation (photos work even if geocoding fails)

### Decision 3: Status Transition

The reverse geocode job should NOT change the asset status because:
- Location enrichment is optional (not all photos have GPS)
- It shouldn't block the asset from being usable
- The status flow is about visual derivatives, not metadata enrichment

**Behavior**: Update location fields only, log the enrichment.

### Decision 4: Queue Assignment

Use **`default`** queue:
- Not CPU-intensive (just API call + DB update)
- Not large file related
- Not AI processing

### Decision 5: Priority

**Priority: 3** (lower than thumbnails at 10 and previews at 5)
- Visual derivatives are more important for UX
- Location data is "nice to have"
- Can be populated in background without urgency

## Implementation Plan

### Phase 1: Move Geocoding Service to Shared Package

**Files to create/modify:**

1. **Create** `packages/shared/src/services/geocoding.service.ts`
   - Move service code from API
   - Export singleton and types

2. **Create** `packages/shared/src/services/index.ts`
   - Export geocoding service

3. **Update** `packages/shared/src/index.ts`
   - Export services

4. **Update** `apps/api/src/services/media/geocoding.service.ts`
   - Re-export from shared package (backwards compatibility)

5. **Update** `apps/api/src/services/upload/upload.service.ts`
   - Remove synchronous geocoding call during upload
   - Add `reverse_geocode` job to queue

### Phase 2: Worker Handler Implementation

**Files to create:**

1. **Create** `apps/worker/src/handlers/reverse-geocode.handler.ts`

```typescript
import { ProcessingJobType } from '@memoriahub/shared';
import { geocodingService } from '@memoriahub/shared';
import { BaseHandler } from './base.handler.js';
import type { JobContext } from '../core/job-context.js';
import type { ProcessingJobResult } from '@memoriahub/shared';

export class ReverseGeocodeHandler extends BaseHandler {
  readonly jobType: ProcessingJobType = 'reverse_geocode';

  async process(context: JobContext): Promise<ProcessingJobResult> {
    const { job, logger } = context;
    const startTime = Date.now();

    // 1. Get the asset
    const asset = await this.getAsset(context);

    // 2. Check for GPS coordinates
    if (asset.latitude === null || asset.longitude === null) {
      logger.info({
        eventType: LogEventTypes.JOB_SKIPPED,
        assetId: asset.id,
        reason: 'No GPS coordinates available',
      });
      return {
        skipped: true,
        reason: 'no_gps_coordinates',
        durationMs: Date.now() - startTime,
      };
    }

    // 3. Check if already geocoded
    if (asset.country !== null || asset.city !== null) {
      logger.info({
        eventType: LogEventTypes.JOB_SKIPPED,
        assetId: asset.id,
        reason: 'Location already geocoded',
      });
      return {
        skipped: true,
        reason: 'already_geocoded',
        durationMs: Date.now() - startTime,
      };
    }

    // 4. Perform reverse geocoding
    logger.info({
      eventType: LogEventTypes.GEOCODING_STARTED,
      assetId: asset.id,
      latitude: asset.latitude,
      longitude: asset.longitude,
    });

    const result = await geocodingService.reverseGeocode(
      asset.latitude,
      asset.longitude
    );

    // 5. Update asset with location data
    if (result.country || result.state || result.city || result.locationName) {
      await mediaAssetRepository.updateLocation(asset.id, {
        country: result.country,
        state: result.state,
        city: result.city,
        locationName: result.locationName,
      });

      logger.info({
        eventType: LogEventTypes.GEOCODING_COMPLETED,
        assetId: asset.id,
        country: result.country,
        state: result.state,
        city: result.city,
      });
    } else {
      logger.warn({
        eventType: LogEventTypes.GEOCODING_NO_RESULTS,
        assetId: asset.id,
        latitude: asset.latitude,
        longitude: asset.longitude,
      });
    }

    return {
      country: result.country,
      state: result.state,
      city: result.city,
      locationName: result.locationName,
      durationMs: Date.now() - startTime,
    };
  }
}
```

2. **Update** `apps/worker/src/handlers/index.ts`
   - Export `ReverseGeocodeHandler`

3. **Update** `apps/worker/src/index.ts`
   - Register handler with router

### Phase 3: Repository Updates

**Files to modify:**

1. **Update** `apps/worker/src/repositories/media-asset.repository.ts`
   - Add `updateLocation(assetId, locationData)` method

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

### Phase 4: Job Queuing

**Files to modify:**

1. **Update** `apps/api/src/services/upload/upload.service.ts`

```typescript
private async queueProcessingJobs(assetId: string, traceId: string | null): Promise<void> {
  await processingJobRepository.createMany([
    {
      assetId,
      jobType: 'generate_thumbnail',
      queue: 'default',
      priority: 10,
      traceId,
    },
    {
      assetId,
      jobType: 'generate_preview',
      queue: 'default',
      priority: 5,
      traceId,
    },
    {
      assetId,
      jobType: 'reverse_geocode',
      queue: 'default',
      priority: 3,    // Lower priority than visual derivatives
      traceId,
    },
  ]);
}
```

2. **Remove** synchronous geocoding calls from:
   - `completeUpload()` method (around line 235-240)
   - `proxyUpload()` method (around line 361-365)

### Phase 5: Observability

**Add Log Event Types** to `apps/worker/src/infrastructure/logging/index.ts`:

```typescript
export const LogEventTypes = {
  // ... existing types
  GEOCODING_STARTED: 'geocoding.started',
  GEOCODING_COMPLETED: 'geocoding.completed',
  GEOCODING_NO_RESULTS: 'geocoding.no_results',
  GEOCODING_ERROR: 'geocoding.error',
  JOB_SKIPPED: 'job.skipped',
};
```

**Add Metrics** to `apps/worker/src/infrastructure/telemetry/metrics.ts`:

```typescript
// Geocoding metrics
export const geocodingDuration = new Histogram({
  name: 'geocoding_duration_seconds',
  help: 'Duration of reverse geocoding operations',
  labelNames: ['status'], // 'success', 'error', 'no_results', 'skipped'
});

export const geocodingCacheHits = new Counter({
  name: 'geocoding_cache_hits_total',
  help: 'Number of geocoding cache hits',
});
```

### Phase 6: Testing

**Files to create:**

1. **Create** `apps/worker/tests/unit/handlers/reverse-geocode.handler.test.ts`

Test cases:
- Successful geocoding with full location data
- Successful geocoding with partial location data (missing city)
- Skip when asset has no GPS coordinates
- Skip when asset already has location data
- Handle geocoding service returning empty results
- Handle geocoding service error (should fail job for retry)
- Verify location update is persisted
- Verify correct logging events

2. **Create** `packages/shared/tests/services/geocoding.service.test.ts`
   - Unit tests for the moved service

## API Changes

None required. The geocoding runs entirely in the worker.

## Database Changes

None required. Schema already supports location fields.

## Configuration

Add optional configuration for geocoding behavior:

```typescript
// apps/worker/src/config/worker.config.ts
export interface GeocodingConfig {
  enabled: boolean;           // Default: true
  skipIfAlreadyGeocoded: boolean;  // Default: true
}
```

Environment variables:
```bash
GEOCODING_ENABLED=true          # Enable/disable geocoding jobs
GEOCODING_SKIP_EXISTING=true    # Skip assets that already have location
```

## Error Handling

| Error Type | Behavior |
|------------|----------|
| Asset not found | Fail job (no retry) |
| No GPS coordinates | Complete with skipped=true |
| Already geocoded | Complete with skipped=true |
| Geocoding API timeout | Fail job (retry) |
| Geocoding API rate limit | Fail job (retry with backoff) |
| Database update error | Fail job (retry) |

## Backfill Strategy

For existing assets without location data:

```bash
# Admin CLI command
.\scripts\dev.ps1 jobs backfill reverse_geocode

# Or via Admin API
POST /api/admin/jobs/backfill
{
  "jobType": "reverse_geocode",
  "filters": {
    "hasGps": true,
    "hasLocation": false
  }
}
```

## File Summary

### New Files (5)
| File | Description |
|------|-------------|
| `packages/shared/src/services/geocoding.service.ts` | Moved geocoding service |
| `packages/shared/src/services/index.ts` | Services export |
| `apps/worker/src/handlers/reverse-geocode.handler.ts` | Handler implementation |
| `apps/worker/tests/unit/handlers/reverse-geocode.handler.test.ts` | Handler tests |
| `packages/shared/tests/services/geocoding.service.test.ts` | Service tests |

### Modified Files (6)
| File | Changes |
|------|---------|
| `packages/shared/src/index.ts` | Export services |
| `apps/api/src/services/media/geocoding.service.ts` | Re-export from shared |
| `apps/api/src/services/upload/upload.service.ts` | Remove sync geocoding, add job |
| `apps/worker/src/handlers/index.ts` | Export new handler |
| `apps/worker/src/index.ts` | Register handler |
| `apps/worker/src/repositories/media-asset.repository.ts` | Add updateLocation method |

## Acceptance Criteria

- [ ] Reverse geocode job processes successfully for assets with GPS coordinates
- [ ] Job is skipped (not failed) for assets without GPS coordinates
- [ ] Job is skipped for assets that already have location data
- [ ] Location data (country, state, city) is persisted to database
- [ ] Job appears in admin dashboard with correct status
- [ ] Geocoding cache prevents duplicate API calls
- [ ] Failed jobs retry with exponential backoff
- [ ] All operations logged with traceId
- [ ] Metrics exported for monitoring
- [ ] Unit tests achieve 80%+ coverage
- [ ] Upload response time improved (geocoding moved to background)

## Open Questions

1. **Should we re-geocode if coordinates change?** (e.g., user manually edits GPS)
   - Recommendation: Add a `forceGeocode` flag to job payload for explicit re-processing

2. **Should geocoding failure block asset from becoming READY?**
   - Recommendation: No, it's optional enrichment

3. **Rate limiting strategy for backfill?**
   - Recommendation: Use lower priority and existing Nominatim rate limit (1/sec)

---

## Implementation Order

1. Move geocoding service to shared package
2. Create handler with tests
3. Add repository method
4. Update upload service to queue job
5. Register handler and deploy
6. Monitor and verify
7. Create backfill script for existing assets
