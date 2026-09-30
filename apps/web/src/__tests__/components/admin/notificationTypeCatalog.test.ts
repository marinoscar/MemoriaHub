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
// Every API `NotificationType` value (apps/api/prisma/schema.prisma).
const EVERY_TYPE = [
  'review_queue_bursts',
  'review_queue_duplicates',
  'review_queue_location_suggestions',
  'review_queue_enhancements',
  'upload_completed',
  'enrichment_failed',
  'workflow_run_completed',
  'share_expiring',
  'memories_ready',
  'admin_broadcast',
  'admin_broadcast_critical',
];

describe('notificationTypeCatalog', () => {
  it('lists every notification type once, with a label and description', () => {
    for (const type of EVERY_TYPE) {
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

  it('marks only the critical broadcast type mandatory, mirroring the API', () => {
    expect(NOTIFICATION_TYPE_CATALOG.filter((info) => info.mandatory).map((info) => info.type)).toEqual([
      'admin_broadcast_critical',
    ]);
    expect(notificationTypeLabel('admin_broadcast')).not.toBe('admin_broadcast');
  });

  it('falls back to the raw key for an unknown type', () => {
    expect(notificationTypeLabel('brand_new_type')).toBe('brand_new_type');
    expect(notificationTypeInfo('brand_new_type')).toMatchObject({ mandatory: false });
  });
});
