/**
 * `services/broadcasts.ts` — epic #481, issue #488. Routes, predicates, the
 * `datetime-local` bridge, and the restated limits asserted against the API's
 * own files on disk so a counter can never promise what the validator refuses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

import { api } from '../../services/api';
import {
  BROADCAST_BODY_MAX,
  BROADCAST_CHANNELS,
  BROADCAST_CTA_LABEL_MAX,
  BROADCAST_LINK_MAX,
  BROADCAST_RECHECK_INTERVAL,
  BROADCAST_STATUSES,
  BROADCAST_TITLE_MAX,
  cancelBroadcast,
  channelLabel,
  createBroadcast,
  deleteBroadcast,
  getBroadcast,
  getBroadcastAudience,
  getBroadcasts,
  isBroadcastCancelable,
  isBroadcastDeletable,
  isBroadcastResumable,
  isoToLocalInput,
  localInputToIso,
  resumeBroadcast,
  sendTestBroadcast,
} from '../../services/broadcasts';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_BROADCASTS = resolve(HERE, '../../../../api/src/notifications/broadcasts');

function readApi(file: string): string {
  return readFileSync(resolve(API_BROADCASTS, file), 'utf-8');
}

describe('services/broadcasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('limits mirror the API', () => {
    it('matches create-broadcast.dto.ts', () => {
      const dto = readApi('dto/create-broadcast.dto.ts');
      expect(dto).toContain(`BROADCAST_TITLE_MAX = ${BROADCAST_TITLE_MAX};`);
      expect(dto).toContain('BROADCAST_BODY_MAX = 2_000;');
      expect(BROADCAST_BODY_MAX).toBe(2000);
      expect(dto).toContain(`BROADCAST_CTA_LABEL_MAX = ${BROADCAST_CTA_LABEL_MAX};`);
      expect(dto).toContain(`BROADCAST_LINK_MAX = ${BROADCAST_LINK_MAX};`);
    });

    it('matches broadcast-constants.ts', () => {
      const constants = readApi('broadcast-constants.ts');
      expect(constants).toContain(`BROADCAST_STATUS_RECHECK_INTERVAL = ${BROADCAST_RECHECK_INTERVAL};`);
      expect(constants).toContain(
        `BROADCAST_CHANNELS = [${BROADCAST_CHANNELS.map((c) => `'${c}'`).join(', ')}] as const;`,
      );
      for (const status of BROADCAST_STATUSES) expect(constants).toContain(`'${status}'`);
    });
  });

  describe('routes', () => {
    it('lists with the query the API honours', async () => {
      await getBroadcasts({ page: 2, pageSize: 50, status: 'failed' });
      expect(api.get).toHaveBeenCalledWith('/admin/broadcasts?page=2&pageSize=50&status=failed');
      await getBroadcasts();
      expect(api.get).toHaveBeenLastCalledWith('/admin/broadcasts');
    });

    it('reads, creates, cancels, resumes, deletes, tests and counts', async () => {
      const body = { title: 't', body: 'b', critical: false, channels: ['inbox' as const] };
      await getBroadcast('b1');
      expect(api.get).toHaveBeenCalledWith('/admin/broadcasts/b1');
      await createBroadcast(body);
      expect(api.post).toHaveBeenCalledWith('/admin/broadcasts', body);
      await cancelBroadcast('b1');
      expect(api.post).toHaveBeenCalledWith('/admin/broadcasts/b1/cancel');
      await resumeBroadcast('b1');
      expect(api.post).toHaveBeenCalledWith('/admin/broadcasts/b1/resume');
      await deleteBroadcast('b1');
      expect(api.delete).toHaveBeenCalledWith('/admin/broadcasts/b1');
      await sendTestBroadcast(body);
      expect(api.post).toHaveBeenCalledWith('/admin/broadcasts/test', body);
      await getBroadcastAudience();
      expect(api.get).toHaveBeenCalledWith('/admin/broadcasts/audience');
    });
  });

  describe('predicates mirror the API 409s', () => {
    it.each([
      ['draft', false, false, true],
      ['scheduled', true, false, true],
      ['sending', true, false, false],
      ['sent', false, false, true],
      ['canceled', false, false, true],
      ['failed', true, true, true],
    ] as const)('%s → cancel %s, resume %s, delete %s', (status, cancel, resume, del) => {
      expect(isBroadcastCancelable({ status })).toBe(cancel);
      expect(isBroadcastResumable({ status })).toBe(resume);
      expect(isBroadcastDeletable({ status })).toBe(del);
    });
  });

  it('labels channels for administrators', () => {
    expect(channelLabel('inbox')).toBe('Inbox');
    expect(channelLabel('push')).toBe('Push');
    expect(channelLabel('email')).toBe('Email');
    expect(channelLabel('sms')).toBe('sms');
  });

  describe('datetime-local bridge', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      process.env.TZ = originalTz;
    });

    it('returns null for empty or garbage input', () => {
      expect(localInputToIso('')).toBeNull();
      expect(localInputToIso('not-a-date')).toBeNull();
      expect(isoToLocalInput('nope')).toBe('');
    });

    it.each(['America/New_York', 'Asia/Tokyo'])('round-trips to the minute in %s', (tz) => {
      process.env.TZ = tz;
      const value = '2026-11-01T01:30';
      const iso = localInputToIso(value)!;
      expect(isoToLocalInput(iso)).toBe(value);
    });

    it('reads the wall clock as local time, not UTC', () => {
      process.env.TZ = 'Asia/Tokyo';
      expect(localInputToIso('2026-03-08T09:00')).toBe('2026-03-08T00:00:00.000Z');
    });
  });
});
