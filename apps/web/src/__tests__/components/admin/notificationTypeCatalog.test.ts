/**
 * `notificationTypeCatalog` — epic #481, issue #487.
 */
import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_TYPE_CATALOG,
  NOTIFICATION_TYPE_KEYS,
  notificationTypeInfo,
  notificationTypeLabel,
} from '../../../components/admin/notificationTypeCatalog';
import type { NotificationType } from '../../../types/notifications';

// Compile-time: every client-side NotificationType is catalogued. If a value is
// added to the union without a catalog entry this list stops type-checking.
const EVERY_TYPE: Record<NotificationType, true> = {
  review_queue_bursts: true,
  review_queue_duplicates: true,
  review_queue_location_suggestions: true,
  review_queue_enhancements: true,
  upload_completed: true,
  enrichment_failed: true,
  workflow_run_completed: true,
  share_expiring: true,
  memories_ready: true,
};

describe('notificationTypeCatalog', () => {
  it('lists every notification type once, with a label and description', () => {
    for (const type of Object.keys(EVERY_TYPE)) {
      expect(NOTIFICATION_TYPE_KEYS).toContain(type);
    }
    expect(new Set(NOTIFICATION_TYPE_KEYS).size).toBe(NOTIFICATION_TYPE_KEYS.length);
    for (const info of NOTIFICATION_TYPE_CATALOG) {
      expect(info.label).not.toBe('');
      expect(info.description).not.toBe('');
    }
  });

  it('reuses the bell labels', () => {
    expect(notificationTypeLabel('upload_completed')).toBe('Upload complete');
  });

  it('falls back to the raw key for an unknown type', () => {
    expect(notificationTypeLabel('brand_new_type')).toBe('brand_new_type');
    expect(notificationTypeInfo('brand_new_type')).toMatchObject({ mandatory: false });
  });
});
