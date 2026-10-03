/**
 * Unit tests for the ISO 6709 location helpers in
 * @memoriahub/enrichment-compute/metadata (issue #545).
 *
 * Videos carry their capture location in the container as an ISO 6709 point
 * string rather than in EXIF. The API and a worker node both parse it through
 * these helpers, so a video's coordinates are identical whichever one probed
 * it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD = '@memoriahub/enrichment-compute/metadata';

/** Compare decimal degrees with a tolerance suited to 6-decimal precision. */
function near(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

test('Samsung/Android decimal degrees with trailing slash', async () => {
  const { parseIso6709 } = await import(MOD);
  const p = parseIso6709('+30.1234-095.4567/');
  near(p.latitude, 30.1234, 'lat');
  near(p.longitude, -95.4567, 'lng');
  assert.equal(p.altitude, undefined);
});

test('iPhone decimal degrees with altitude', async () => {
  const { parseIso6709 } = await import(MOD);
  const p = parseIso6709('+30.1234-095.4567+012.345/');
  near(p.latitude, 30.1234, 'lat');
  near(p.longitude, -95.4567, 'lng');
  near(p.altitude, 12.345, 'alt');
});

test('negative altitude and southern/eastern hemispheres', async () => {
  const { parseIso6709 } = await import(MOD);
  const p = parseIso6709('-33.8688+151.2093-005.5/');
  near(p.latitude, -33.8688, 'lat');
  near(p.longitude, 151.2093, 'lng');
  near(p.altitude, -5.5, 'alt');
});

test('no trailing slash', async () => {
  const { parseIso6709 } = await import(MOD);
  const p = parseIso6709('+9.9281-084.0907');
  near(p.latitude, 9.9281, 'lat');
  near(p.longitude, -84.0907, 'lng');
});

test('surrounding whitespace is tolerated', async () => {
  const { parseIso6709 } = await import(MOD);
  const p = parseIso6709('  +30.1234-095.4567/ \n');
  near(p.latitude, 30.1234, 'lat');
});

test('a CRS suffix is accepted and ignored', async () => {
  const { parseIso6709 } = await import(MOD);
  const p = parseIso6709('+30.1234-095.4567+012.3CRSWGS_84/');
  near(p.latitude, 30.1234, 'lat');
  near(p.longitude, -95.4567, 'lng');
  near(p.altitude, 12.3, 'alt');
});

test('degrees-minutes form (±DDMM.MMM±DDDMM.MMM)', async () => {
  const { parseIso6709 } = await import(MOD);
  // 30°07.404' N, 095°27.402' W
  const p = parseIso6709('+3007.404-09527.402/');
  near(p.latitude, 30 + 7.404 / 60, 'lat');
  near(p.longitude, -(95 + 27.402 / 60), 'lng');
});

test('degrees-minutes-seconds form (±DDMMSS.SS±DDDMMSS.SS)', async () => {
  const { parseIso6709 } = await import(MOD);
  // 40°26'46.30" N, 079°58'56.00" W
  const p = parseIso6709('+402646.30-0795856.00/');
  near(p.latitude, 40 + 26 / 60 + 46.3 / 3600, 'lat');
  near(p.longitude, -(79 + 58 / 60 + 56 / 3600), 'lng');
});

test('integer-only degrees-minutes-seconds without a fraction', async () => {
  const { parseIso6709 } = await import(MOD);
  const p = parseIso6709('+402646-0795856/');
  near(p.latitude, 40 + 26 / 60 + 46 / 3600, 'lat');
  near(p.longitude, -(79 + 58 / 60 + 56 / 3600), 'lng');
});

test('minutes or seconds of 60 or more are rejected', async () => {
  const { parseIso6709 } = await import(MOD);
  assert.equal(parseIso6709('+3060.000-09527.402/'), null);
  assert.equal(parseIso6709('+402660-0795856/'), null);
});

test('exact 0,0 is treated as no location', async () => {
  const { parseIso6709 } = await import(MOD);
  assert.equal(parseIso6709('+00.0000+000.0000/'), null);
  assert.equal(parseIso6709('+00.0000+000.0000+000.000/'), null);
  // A real point on the equator or the prime meridian is still a location.
  assert.ok(parseIso6709('+00.0000+010.0000/'));
  assert.ok(parseIso6709('+51.4779+000.0000/'));
});

test('out-of-range coordinates are rejected', async () => {
  const { parseIso6709 } = await import(MOD);
  assert.equal(parseIso6709('+91.0000-095.4567/'), null);
  assert.equal(parseIso6709('+30.1234-180.5000/'), null);
  assert.equal(parseIso6709('-90.0001+000.1000/'), null);
  // The poles and the antimeridian themselves are valid.
  assert.ok(parseIso6709('+90.0000+000.0000/'));
  assert.ok(parseIso6709('+10.0000-180.0000/'));
});

test('ambiguous digit counts are rejected rather than guessed', async () => {
  const { parseIso6709 } = await import(MOD);
  // 3 integer digits of latitude fit none of the DD / DDMM / DDMMSS forms.
  assert.equal(parseIso6709('+301.234-095.4567/'), null);
  // 4 integer digits of longitude fit none of DDD / DDDMM / DDDMMSS.
  assert.equal(parseIso6709('+30.1234-0954.567/'), null);
});

test('garbage and non-strings return null', async () => {
  const { parseIso6709 } = await import(MOD);
  for (const value of [
    '',
    '/',
    'location',
    '30.1234,-95.4567',
    '+30.1234',
    '+30.1234-095.4567/extra',
    '++30.1-095.4/',
    '+30.-095.4/',
    undefined,
    null,
    42,
    { latitude: 1, longitude: 2 },
  ]) {
    assert.equal(parseIso6709(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test('extractVideoLocation prefers the Apple tag over location', async () => {
  const { extractVideoLocation } = await import(MOD);
  const loc = extractVideoLocation({
    location: '+10.0000+020.0000/',
    'com.apple.quicktime.location.iso6709': '+30.1234-095.4567+012.345/',
  });
  near(loc.latitude, 30.1234, 'lat');
  near(loc.altitude, 12.345, 'alt');
  assert.equal(loc.tag, 'com.apple.quicktime.location.iso6709');
});

test('extractVideoLocation reads the Android location and location-eng tags', async () => {
  const { extractVideoLocation } = await import(MOD);
  assert.equal(extractVideoLocation({ location: '+30.1234-095.4567/' }).tag, 'location');
  assert.equal(
    extractVideoLocation({ 'location-eng': '+30.1234-095.4567/' }).tag,
    'location-eng',
  );
});

test('extractVideoLocation skips an unparseable known tag and falls through', async () => {
  const { extractVideoLocation } = await import(MOD);
  const loc = extractVideoLocation({
    'com.apple.quicktime.location.iso6709': '+00.0000+000.0000/',
    location: '+30.1234-095.4567/',
  });
  assert.equal(loc.tag, 'location');
});

test('extractVideoLocation falls back to a vendor variant mentioning location', async () => {
  const { extractVideoLocation } = await import(MOD);
  const loc = extractVideoLocation({
    encoder: 'Lavf60',
    'com.android.capture.location': '+30.1234-095.4567/',
  });
  near(loc.longitude, -95.4567, 'lng');
  assert.equal(loc.tag, 'com.android.capture.location');
});

test('extractVideoLocation returns undefined when no tag carries a location', async () => {
  const { extractVideoLocation } = await import(MOD);
  assert.equal(extractVideoLocation({}), undefined);
  assert.equal(extractVideoLocation({ encoder: 'Lavf60', location: 'garbage' }), undefined);
});
