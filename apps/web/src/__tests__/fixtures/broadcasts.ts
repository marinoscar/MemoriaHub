/** Shared broadcast fixture for the #488 suites. */
import type { Broadcast } from '../../services/broadcasts';

export function makeBroadcast(overrides: Partial<Broadcast> = {}): Broadcast {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    title: 'Planned maintenance',
    body: 'Offline tonight.',
    link: null,
    ctaLabel: null,
    critical: false,
    channels: ['inbox'],
    status: 'sent',
    scheduledFor: null,
    audienceCutoff: null,
    recipientCount: 10,
    processedCount: 10,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    canceledAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdBy: { id: 'u1', email: 'admin@example.com', displayName: 'Ada' },
    canceledBy: null,
    ...overrides,
  };
}
