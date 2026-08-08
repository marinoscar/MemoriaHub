/**
 * test/backup/layout.spec.ts — Backup root layout planning + writers.
 *
 * Covers: offset-aware month bucketing (capturedAtOffset in MINUTES), the
 * unknown-date bucket (no upload-date fallback), archived-tree selection,
 * filename sanitization (separators, control chars, Windows-reserved names,
 * long names, empty), the deterministic ~id8 collision policy, the sidecar
 * writer, and the archive/unarchive move helper.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  absPathFor,
  bucketSegments,
  createRootSkeleton,
  moveItemFiles,
  planRelPath,
  planTreeTransition,
  sanitizeFilename,
  sidecarRelPathFor,
  treeFor,
  writeSidecar,
  type PlanRelPathInput,
} from '../../src/backup/layout.js';

describe('bucketSegments', () => {
  it('buckets by the human-local capture date (offset in MINUTES)', () => {
    // UTC 2024-03-31T23:30 with +120 minutes → local 2024-04-01T01:30 → 2024/04.
    expect(bucketSegments('2024-03-31T23:30:00.000Z', 120)).toEqual(['2024', '04']);
  });

  it('a negative offset can shift back across a month boundary', () => {
    // UTC 2024-04-01T00:30 with -120 → local 2024-03-31T22:30 → 2024/03.
    expect(bucketSegments('2024-04-01T00:30:00.000Z', -120)).toEqual(['2024', '03']);
  });

  it('null offset means UTC', () => {
    expect(bucketSegments('2024-07-15T10:00:00.000Z', null)).toEqual(['2024', '07']);
  });

  it('null capturedAt buckets into unknown-date (never the upload date)', () => {
    expect(bucketSegments(null, null)).toEqual(['unknown-date']);
    expect(bucketSegments(null, 120)).toEqual(['unknown-date']);
  });

  it('an unparsable capturedAt falls back to unknown-date', () => {
    expect(bucketSegments('not-a-date', 0)).toEqual(['unknown-date']);
  });

  it('accepts a Date instance', () => {
    expect(bucketSegments(new Date(Date.UTC(2023, 11, 31, 23, 0)), 60)).toEqual(['2024', '01']);
  });
});

describe('treeFor / planRelPath tree selection', () => {
  const base: PlanRelPathInput = {
    mediaItemId: 'aaaa1111-2222-3333-4444-555566667777',
    originalFilename: 'IMG_0001.jpg',
    capturedAt: '2024-03-10T12:00:00.000Z',
    capturedAtOffset: 0,
    archivedAt: null,
  };
  const free = (): null => null;

  it('active items live under media/YYYY/MM', () => {
    expect(treeFor(null)).toBe('media');
    expect(planRelPath(base, free)).toBe('media/2024/03/IMG_0001.jpg');
  });

  it('archived items live under archived/YYYY/MM — their own tree', () => {
    expect(treeFor('2024-05-01T00:00:00.000Z')).toBe('archived');
    expect(planRelPath({ ...base, archivedAt: '2024-05-01T00:00:00.000Z' }, free)).toBe(
      'archived/2024/03/IMG_0001.jpg',
    );
  });

  it('archived + null capturedAt → archived/unknown-date', () => {
    expect(
      planRelPath(
        { ...base, capturedAt: null, archivedAt: '2024-05-01T00:00:00.000Z' },
        free,
      ),
    ).toBe('archived/unknown-date/IMG_0001.jpg');
  });
});

describe('sanitizeFilename', () => {
  it('replaces path separators and invalid characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFilename('a\\b/c.jpg')).toBe('a_b_c.jpg');
    expect(sanitizeFilename('we<ird>:"name"|?*.png')).toBe('we_ird___name____.png');
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('bad\x00name\x1f\x7f.jpg')).toBe('badname.jpg');
  });

  it('guards Windows-reserved names, case-insensitive, with and without extension', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('con.txt')).toBe('_con.txt');
    expect(sanitizeFilename('Com7.JPG')).toBe('_Com7.JPG');
    expect(sanitizeFilename('lpt9')).toBe('_lpt9');
    // COM without a digit is NOT reserved.
    expect(sanitizeFilename('COM.txt')).toBe('COM.txt');
    expect(sanitizeFilename('COM10.txt')).toBe('COM10.txt');
  });

  it('trims trailing dots/spaces and leading dots', () => {
    expect(sanitizeFilename('photo.jpg. ')).toBe('photo.jpg');
    expect(sanitizeFilename('.hidden.jpg')).toBe('hidden.jpg');
  });

  it('trims to 200 UTF-8 bytes preserving the extension, on a code-point boundary', () => {
    const longStem = 'á'.repeat(150); // 2 bytes each → 300 bytes
    const out = sanitizeFilename(`${longStem}.jpg`);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(200);
    expect(out.endsWith('.jpg')).toBe(true);
    // 200 - 4 (.jpg) = 196 budget → 98 two-byte chars.
    expect(out).toBe('á'.repeat(98) + '.jpg');
  });

  it('falls back when nothing usable remains', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('...')).toBe('file');
    expect(sanitizeFilename('\x00\x01')).toBe('file');
  });
});

describe('planRelPath collision policy', () => {
  const item: PlanRelPathInput = {
    mediaItemId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    originalFilename: 'IMG_0001.jpg',
    capturedAt: '2024-03-10T12:00:00.000Z',
    capturedAtOffset: 0,
    archivedAt: null,
  };

  it('keeps the plain name when the path is free or claimed by the SAME item', () => {
    expect(planRelPath(item, () => null)).toBe('media/2024/03/IMG_0001.jpg');
    expect(planRelPath(item, () => item.mediaItemId)).toBe('media/2024/03/IMG_0001.jpg');
  });

  it('appends ~<first8ofMediaItemId> when a DIFFERENT item claims the path', () => {
    const owners = new Map<string, string>([['media/2024/03/IMG_0001.jpg', 'other-item']]);
    const rel = planRelPath(item, (p) => owners.get(p) ?? null);
    expect(rel).toBe('media/2024/03/IMG_0001~a1b2c3d4.jpg');
  });

  it('is deterministic and stable across calls', () => {
    const owners = new Map<string, string>([['media/2024/03/IMG_0001.jpg', 'other-item']]);
    const lookup = (p: string): string | null => owners.get(p) ?? null;
    const first = planRelPath(item, lookup);
    // Simulate the catalog now recording OUR claim on the suffixed path.
    owners.set(first, item.mediaItemId);
    const second = planRelPath(item, lookup);
    expect(second).toBe(first);
  });

  it('falls back to the full-id suffix on a double collision', () => {
    const owners = new Map<string, string>([
      ['media/2024/03/IMG_0001.jpg', 'other-item'],
      ['media/2024/03/IMG_0001~a1b2c3d4.jpg', 'third-item'],
    ]);
    const rel = planRelPath(item, (p) => owners.get(p) ?? null);
    expect(rel).toBe(`media/2024/03/IMG_0001~${item.mediaItemId}.jpg`);
  });
});

describe('writers (skeleton, sidecar, moves)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-layout-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('createRootSkeleton creates the fixed directories (idempotent)', () => {
    createRootSkeleton(root);
    createRootSkeleton(root);
    for (const rel of ['media', 'archived', '_quarantine', 'catalog', '.memoriahub/tmp']) {
      expect(fs.statSync(absPathFor(root, rel)).isDirectory()).toBe(true);
    }
  });

  it('writeSidecar writes <rel_path>.json atomically with the payload verbatim', () => {
    const payload = { schemaVersion: 1, mediaItemId: 'x', tags: [{ name: 'beach' }] };
    const sidecarRel = writeSidecar(root, 'media/2024/03/IMG_0001.jpg', payload);
    expect(sidecarRel).toBe('media/2024/03/IMG_0001.jpg.json');

    const abs = absPathFor(root, sidecarRel);
    expect(JSON.parse(fs.readFileSync(abs, 'utf8'))).toEqual(payload);
    // No temp files left behind.
    const entries = fs.readdirSync(path.dirname(abs));
    expect(entries).toEqual(['IMG_0001.jpg.json']);
  });

  it('planTreeTransition flips media/ ↔ archived/ preserving bucket + filename', () => {
    expect(planTreeTransition('media/2024/03/a.jpg', '2024-05-01T00:00:00.000Z')).toEqual({
      fromRelPath: 'media/2024/03/a.jpg',
      toRelPath: 'archived/2024/03/a.jpg',
      changed: true,
    });
    expect(planTreeTransition('archived/unknown-date/b.jpg', null)).toEqual({
      fromRelPath: 'archived/unknown-date/b.jpg',
      toRelPath: 'media/unknown-date/b.jpg',
      changed: true,
    });
    // Already in the right tree → no move.
    expect(planTreeTransition('media/2024/03/a.jpg', null).changed).toBe(false);
    // Outside both trees (quarantine) → untouched.
    expect(planTreeTransition('_quarantine/a.jpg', '2024-05-01T00:00:00.000Z').changed).toBe(false);
  });

  it('moveItemFiles moves the file AND its sidecar to the new tree', () => {
    const fromRel = 'media/2024/03/IMG_0001.jpg';
    const fromAbs = absPathFor(root, fromRel);
    fs.mkdirSync(path.dirname(fromAbs), { recursive: true });
    fs.writeFileSync(fromAbs, 'bytes');
    writeSidecar(root, fromRel, { schemaVersion: 1 });

    const { toRelPath } = planTreeTransition(fromRel, '2024-05-01T00:00:00.000Z');
    const moved = moveItemFiles(root, fromRel, toRelPath);
    expect(moved).toBe('archived/2024/03/IMG_0001.jpg');

    expect(fs.existsSync(fromAbs)).toBe(false);
    expect(fs.existsSync(absPathFor(root, sidecarRelPathFor(fromRel)))).toBe(false);
    expect(fs.readFileSync(absPathFor(root, moved), 'utf8')).toBe('bytes');
    expect(fs.existsSync(absPathFor(root, sidecarRelPathFor(moved)))).toBe(true);
  });

  it('moveItemFiles tolerates a missing sidecar', () => {
    const fromRel = 'media/2024/03/solo.jpg';
    const fromAbs = absPathFor(root, fromRel);
    fs.mkdirSync(path.dirname(fromAbs), { recursive: true });
    fs.writeFileSync(fromAbs, 'bytes');

    const moved = moveItemFiles(root, fromRel, 'archived/2024/03/solo.jpg');
    expect(fs.readFileSync(absPathFor(root, moved), 'utf8')).toBe('bytes');
  });
});
