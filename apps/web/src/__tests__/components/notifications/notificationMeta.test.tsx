/**
 * notificationMeta — per-type icon/tone/label (issue #249; admin broadcasts
 * added in issue #488).
 */
import { describe, it, expect } from 'vitest';
import { notificationMeta } from '../../../components/notifications/notificationMeta';

describe('notificationMeta', () => {
  it('describes a routine admin broadcast as an announcement', () => {
    const meta = notificationMeta('admin_broadcast');
    expect(meta.label).toBe('Announcement');
    expect(meta.tone).toBe('info');
  });

  it('gives a critical broadcast its own label and an error tone', () => {
    const meta = notificationMeta('admin_broadcast_critical');
    expect(meta.label).toBe('Important announcement');
    expect(meta.tone).toBe('error');
  });

  it('falls back to a generic bell for an unknown type', () => {
    expect(notificationMeta('brand_new_type').label).toBe('Notification');
  });
});
