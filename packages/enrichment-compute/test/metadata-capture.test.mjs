/**
 * Unit tests for the capture-timestamp helpers in
 * @memoriahub/enrichment-compute/metadata (issue #443, epic #440).
 *
 * `media_items.captured_at` holds a CIVIL timestamp — the wall clock at
 * capture, re-encoded as UTC — for photos. Videos stored a real INSTANT in the
 * same column, so a video shot at 20:16 in a UTC-6 zone landed on the next
 * calendar day and separated from photos taken minutes beside it. These tests
 * pin the shared re-encode both paths now go through, so the two cannot drift.
 *
 * The assertions are timezone-independent by construction: the helper reads
 * explicit components, never the ambient zone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD = '@memoriahub/enrichment-compute/metadata';

test('wallClockToCivilTimestamp stamps the components verbatim as UTC', async () => {
  const { wallClockToCivilTimestamp } = await import(MOD);
  assert.equal(
    wallClockToCivilTimestamp({
      year: 2026,
      month: 6, // 1-based, not the JS month index
      day: 20,
      hour: 20,
      minute: 16,
      second: 7,
    }),
    '2026-06-20T20:16:07.000Z',
  );
});

test('wallClockToCivilTimestamp carries sub-second precision', async () => {
  const { wallClockToCivilTimestamp } = await import(MOD);
  assert.equal(
    wallClockToCivilTimestamp({
      year: 2026,
      month: 1,
      day: 2,
      hour: 3,
      minute: 4,
      second: 5,
      ms: 250,
    }),
    '2026-01-02T03:04:05.250Z',
  );
});

test('Apple creationdate with a negative offset yields the wall clock', async () => {
  const { parseVideoCaptureTimestamp } = await import(MOD);
  const result = parseVideoCaptureTimestamp({
    'com.apple.quicktime.creationdate': '2026-06-20T20:16:07-0600',
    creation_time: '2026-06-21T02:16:07.000000Z',
  });

  // The whole point: 20:16 on June 20, NOT 02:16 on June 21.
  assert.equal(result.capturedAt, '2026-06-20T20:16:07.000Z');
  assert.equal(result.capturedAtOffset, -360);
  assert.equal(result.source, 'wall_clock');
  assert.equal(result.tag, 'com.apple.quicktime.creationdate');
});

test('Apple creationdate with a positive offset yields the wall clock', async () => {
  const { parseVideoCaptureTimestamp } = await import(MOD);
  const result = parseVideoCaptureTimestamp({
    'com.apple.quicktime.creationdate': '2026-06-20T20:16:07+05:30',
  });
  assert.equal(result.capturedAt, '2026-06-20T20:16:07.000Z');
  assert.equal(result.capturedAtOffset, 330);
  assert.equal(result.source, 'wall_clock');
});

test('the local-time tag beats a bare creation_time even when listed later', async () => {
  const { parseVideoCaptureTimestamp } = await import(MOD);
  const result = parseVideoCaptureTimestamp({
    creation_time: '2026-06-21T02:16:07.000000Z',
    date: '2026-06-20T20:16:07-0600',
  });
  assert.equal(result.capturedAt, '2026-06-20T20:16:07.000Z');
  assert.equal(result.tag, 'date');
});

test('creation_time only: the UTC instant is kept and flagged', async () => {
  const { parseVideoCaptureTimestamp } = await import(MOD);
  const result = parseVideoCaptureTimestamp({
    creation_time: '2026-06-21T02:16:07.000000Z',
  });
  // Unchanged from the pre-fix behaviour — the capture zone is unknowable here
  // and guessing one would be worse than a known-imperfect value.
  assert.equal(result.capturedAt, '2026-06-21T02:16:07.000Z');
  assert.equal(result.capturedAtOffset, undefined);
  assert.equal(result.source, 'instant');
});

test('an instant plus an offset stated by another tag recovers the wall clock', async () => {
  const { parseVideoCaptureTimestamp } = await import(MOD);
  const result = parseVideoCaptureTimestamp({
    creation_time: '2026-06-21T02:16:07.000000Z',
    time_offset: '-06:00',
  });
  assert.equal(result.capturedAt, '2026-06-20T20:16:07.000Z');
  assert.equal(result.capturedAtOffset, -360);
  assert.equal(result.source, 'wall_clock');
});

test('no capture tag at all returns undefined', async () => {
  const { parseVideoCaptureTimestamp } = await import(MOD);
  assert.equal(parseVideoCaptureTimestamp({}), undefined);
  assert.equal(parseVideoCaptureTimestamp({ encoder: 'Lavf60' }), undefined);
});

test('an unparseable capture tag returns undefined rather than Invalid Date', async () => {
  const { parseVideoCaptureTimestamp } = await import(MOD);
  assert.equal(parseVideoCaptureTimestamp({ creation_time: 'not a date' }), undefined);
  assert.equal(parseVideoCaptureTimestamp({ creation_time: '' }), undefined);
});

test('a video and a photo captured a minute apart land on the same civil day', async () => {
  const { parseVideoCaptureTimestamp, wallClockToCivilTimestamp } = await import(MOD);

  // Photo: EXIF DateTimeOriginal 2026:06:20 20:17:00 (tz-naive).
  const photo = wallClockToCivilTimestamp({
    year: 2026,
    month: 6,
    day: 20,
    hour: 20,
    minute: 17,
    second: 0,
  });
  // Video: same evening, one minute earlier, Apple local-time tag.
  const video = parseVideoCaptureTimestamp({
    'com.apple.quicktime.creationdate': '2026-06-20T20:16:00-0600',
  }).capturedAt;

  assert.equal(photo.slice(0, 10), video.slice(0, 10));
  assert.ok(new Date(video) < new Date(photo));
});
