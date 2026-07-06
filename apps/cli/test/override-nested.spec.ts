/**
 * VERIFICATION: nested per-folder memoriahub.json resolution.
 *
 * Drives the REAL production functions the scan/sync engines use
 * (enumerateFiles + loadOverrideFile + pickFallback) against a real on-disk
 * nested folder tree, to prove each media file resolves to its OWN folder's
 * memoriahub.json at any depth.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { enumerateFiles } from '../src/files.js';
import { loadOverrideFile, pickFallback } from '../src/override.js';

const GPSLESS = { hasGps: false as const, capturedAt: null };

function writeJson(dir: string, lat: number, lng: number): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'memoriahub.json'),
    JSON.stringify({ version: 1, fallback: { location: { latitude: lat, longitude: lng } } }),
  );
}
function writePhoto(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.from('not-a-real-jpeg'));
}

// Exactly mirror the engines: file -> path.dirname -> loadOverrideFile -> pickFallback
function resolveForFile(filePath: string): ReturnType<typeof pickFallback> {
  const override = loadOverrideFile(path.dirname(filePath));
  return pickFallback(override, path.basename(filePath), GPSLESS);
}

describe('memoriahub.json nested per-folder resolution (real production functions)', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-nested-'));
    writeJson(root, 10, 20); //                 main/
    writePhoto(root, 'a.jpg');
    writeJson(path.join(root, 'sub1'), 30, -40); //          main/sub1/
    writePhoto(path.join(root, 'sub1'), 'b.jpg');
    writeJson(path.join(root, 'sub2'), -50, 60); //          main/sub2/
    writePhoto(path.join(root, 'sub2'), 'c.jpg');
    writeJson(path.join(root, 'sub1', 'deep'), 70, -80); //  main/sub1/deep/  (deeply nested)
    writePhoto(path.join(root, 'sub1', 'deep'), 'd.jpg');
    writePhoto(path.join(root, 'nojson'), 'e.jpg'); //       main/nojson/ (no sidecar)
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('recursive scan finds every photo at every depth and never enumerates the sidecar', () => {
    const { supported } = enumerateFiles(root, true);
    const names = supported.map((f) => path.basename(f.filePath)).sort();
    expect(names).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']);
    expect(supported.some((f) => f.filePath.endsWith('memoriahub.json'))).toBe(false);
  });

  it("each photo uses its OWN folder's memoriahub.json (nearest = own dir), at any depth", () => {
    const { supported } = enumerateFiles(root, true);
    const byName = Object.fromEntries(
      supported.map((f) => [path.basename(f.filePath), f.filePath]),
    );
    expect(resolveForFile(byName['a.jpg'])).toMatchObject({ takenLat: 10, takenLng: 20 });
    expect(resolveForFile(byName['b.jpg'])).toMatchObject({ takenLat: 30, takenLng: -40 });
    expect(resolveForFile(byName['c.jpg'])).toMatchObject({ takenLat: -50, takenLng: 60 });
    expect(resolveForFile(byName['d.jpg'])).toMatchObject({ takenLat: 70, takenLng: -80 });
  });

  it('a folder WITHOUT its own memoriahub.json inherits NOTHING from ancestors (documented limitation)', () => {
    const { supported } = enumerateFiles(root, true);
    const e = supported.find((f) => path.basename(f.filePath) === 'e.jpg')!;
    expect(resolveForFile(e.filePath)).toEqual({});
  });

  it('NON-recursive scan sees only the top folder — subfolder overrides are never reached', () => {
    const { supported } = enumerateFiles(root, false);
    const names = supported.map((f) => path.basename(f.filePath)).sort();
    expect(names).toEqual(['a.jpg']);
  });
});
