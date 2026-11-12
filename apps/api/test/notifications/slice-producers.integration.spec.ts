import {
  EnrichmentFailureNotificationListener,
  ReviewQueueCounterRegistry,
  ShareExpiringHandler,
  ShareExpiringService,
} from '@marinoscar/memoriahub-api/media';
import { JobHandlerRegistry } from '@marinoscar/platform-api/jobs';
import { MEMORIAHUB_SHARING } from '@marinoscar/memoriahub-api/ports';

import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';

/**
 * The notification producers the media slice owns, as the app boots them (RETRO-J10, #624): each slice
 * registered its review-queue counter, the failure listener and the expiring-share sweep are providers, and
 * the sharing port is bound over the platform sharing slice.
 */
describe('Slice-owned notification producers (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  it('registers the four review-queue counters, one per owning slice, under the permanent keys and events', () => {
    const counters = context.module.get(ReviewQueueCounterRegistry, { strict: false }).all();
    expect(counters.map((c) => [c.countKey, c.eventKey])).toEqual([
      ['pendingBurstGroups', 'review.bursts'],
      ['pendingDuplicateGroups', 'review.duplicates'],
      ['pendingLocationSuggestions', 'review.location_suggestions'],
      ['pendingEnhancements', 'review.enhancements'],
    ]);
  });

  it('provides the failure listener and the share-expiring sweep, with the permanent job type registered', () => {
    expect(context.module.get(EnrichmentFailureNotificationListener, { strict: false })).toBeDefined();
    expect(context.module.get(ShareExpiringService, { strict: false })).toBeDefined();
    expect(context.module.get(ShareExpiringHandler, { strict: false }).type).toBe('shares.expiring_sweep');
    expect(context.module.get(JobHandlerRegistry, { strict: false }).get('shares.expiring_sweep')).toBeDefined();
  });

  it('binds the sharing port over the platform sharing slice', () => {
    const sharing = context.module.get(MEMORIAHUB_SHARING, { strict: false }) as { listExpiringLinks: unknown };
    expect(typeof sharing.listExpiringLinks).toBe('function');
  });
});
