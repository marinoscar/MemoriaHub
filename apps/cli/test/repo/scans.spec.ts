/**
 * test/repo/scans.spec.ts
 *
 * Unit tests for ScanRepo — all operations against an in-memory SQLite DB.
 * Mirrors the style of test/repo/files.spec.ts.
 */

import { openDb } from '../../src/db/database.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { ScanRepo } from '../../src/repo/scans.js';
import type { ScanFileInput } from '../../src/repo/scans.js';
import type BetterSqlite3 from 'better-sqlite3';

function makeDb(): BetterSqlite3.Database {
  return openDb(':memory:');
}

/** Create a real folder row for realism (scan_files.folder_id has no FK constraint). */
function seedFolder(db: BetterSqlite3.Database, folderPath: string): number {
  const repo = new FolderRepo(db);
  return repo.add({ path: folderPath }).id;
}

/** Convenience builder for a ScanFileInput with sensible defaults. */
function baseFile(overrides: Partial<ScanFileInput> = {}): ScanFileInput {
  return {
    folderId: 1,
    filePath: '/tmp/f.jpg',
    sizeBytes: 1000,
    mtimeMs: 123456,
    mimeType: 'image/jpeg',
    mediaKind: 'photo',
    hasExif: false,
    hasGps: false,
    ...overrides,
  };
}

describe('ScanRepo', () => {
  let db: BetterSqlite3.Database;
  let repo: ScanRepo;
  let folderId: number;

  beforeEach(() => {
    db = makeDb();
    repo = new ScanRepo(db);
    folderId = seedFolder(db, '/tmp/scan-testfolder');
  });

  afterEach(() => {
    db.close();
  });

  // ---------------------------------------------------------------------------
  // startScan / getScan
  // ---------------------------------------------------------------------------

  describe('startScan', () => {
    it('creates a scan row in running status with zeroed rollups', () => {
      const scanId = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      expect(scanId).toBeGreaterThan(0);

      const scan = repo.getScan(scanId);
      expect(scan).not.toBeNull();
      expect(scan!.status).toBe('running');
      expect(scan!.trigger).toBe('cli');
      expect(JSON.parse(scan!.folder_ids)).toEqual([folderId]);
      expect(scan!.total_files).toBe(0);
      expect(scan!.total_bytes).toBe(0);
      expect(scan!.finished_at).toBeNull();
    });
  });

  describe('getScan', () => {
    it('returns null for an unknown scan id', () => {
      expect(repo.getScan(999999)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Seed helper: insert a realistic mixed set of scan_files rows
  // ---------------------------------------------------------------------------

  /**
   * Seeds a scan with a realistic mix:
   *  - 2 photos with hasExif=true, hasGps=true (one Apple/iPhone, one Apple/iPhone — same make/model)
   *  - 1 photo with hasExif=false
   *  - 1 video
   *  - 1 photo with only cameraMake set (no model)
   *  - varying sizeBytes, capturedAt, one row with metaError set
   * Returns the scanId and folder2Id (a second folder used for folderBreakdown tests).
   */
  function seedMixedScan(): { scanId: number; folder2Id: number } {
    const scanId = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
    const folder2Id = seedFolder(db, '/tmp/scan-testfolder2');

    // Photo 1: full EXIF + GPS, Apple iPhone, capturedAt set
    repo.insertScanFile(scanId, baseFile({
      folderId,
      filePath: '/tmp/a1.jpg',
      sizeBytes: 5_000_000,
      mediaKind: 'photo',
      hasExif: true,
      hasGps: true,
      capturedAt: '2026-01-01T00:00:00.000Z',
      cameraMake: 'Apple',
      cameraModel: 'iPhone 14',
    }));

    // Photo 2: full EXIF + GPS, same make/model as photo 1 (for grouping test)
    repo.insertScanFile(scanId, baseFile({
      folderId,
      filePath: '/tmp/a2.jpg',
      sizeBytes: 6_000_000,
      mediaKind: 'photo',
      hasExif: true,
      hasGps: true,
      capturedAt: '2026-01-02T00:00:00.000Z',
      cameraMake: 'Apple',
      cameraModel: 'iPhone 14',
    }));

    // Photo 3: no EXIF at all
    repo.insertScanFile(scanId, baseFile({
      folderId,
      filePath: '/tmp/a3.jpg',
      sizeBytes: 2_000_000,
      mediaKind: 'photo',
      hasExif: false,
      hasGps: false,
    }));

    // Photo 4: only cameraMake set (no model) — distinct make from Apple, for
    // camera-breakdown ordering (appears once, less frequent than Apple's 2).
    repo.insertScanFile(scanId, baseFile({
      folderId,
      filePath: '/tmp/a4.jpg',
      sizeBytes: 3_000_000,
      mediaKind: 'photo',
      hasExif: true,
      hasGps: false,
      capturedAt: '2026-01-03T00:00:00.000Z',
      cameraMake: 'Samsung',
      cameraModel: null,
    }));

    // Video
    repo.insertScanFile(scanId, baseFile({
      folderId,
      filePath: '/tmp/v1.mp4',
      sizeBytes: 50_000_000,
      mimeType: 'video/mp4',
      mediaKind: 'video',
      hasExif: false,
      hasGps: false,
    }));

    // A row in folder2, with a metaError set and no size (null) so it's excluded
    // from largestFiles.
    repo.insertScanFile(scanId, baseFile({
      folderId: folder2Id,
      filePath: '/tmp/scan-testfolder2/bad.jpg',
      sizeBytes: null,
      mediaKind: 'photo',
      hasExif: false,
      hasGps: false,
      metaError: 'Corrupt EXIF block',
    }));

    return { scanId, folder2Id };
  }

  // ---------------------------------------------------------------------------
  // computeTotals
  // ---------------------------------------------------------------------------

  describe('computeTotals', () => {
    it('rolls up totalFiles/totalBytes/photoCount/videoCount/exifCount/gpsCount exactly', () => {
      const { scanId } = seedMixedScan();

      const totals = repo.computeTotals(scanId);
      // 6 rows total
      expect(totals.totalFiles).toBe(6);
      // Sum of size_bytes: 5M + 6M + 2M + 3M + 50M + 0(null->not counted) = 66,000,000
      expect(totals.totalBytes).toBe(5_000_000 + 6_000_000 + 2_000_000 + 3_000_000 + 50_000_000);
      // photos: a1,a2,a3,a4,bad = 5; video: v1 = 1
      expect(totals.photoCount).toBe(5);
      expect(totals.videoCount).toBe(1);
      // hasExif=true: a1,a2,a4 = 3
      expect(totals.exifCount).toBe(3);
      // hasGps=true: a1,a2 = 2
      expect(totals.gpsCount).toBe(2);
    });

    it('returns all zeros for a scan with no files', () => {
      const scanId = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      const totals = repo.computeTotals(scanId);
      expect(totals).toEqual({
        totalFiles: 0,
        totalBytes: 0,
        photoCount: 0,
        videoCount: 0,
        exifCount: 0,
        gpsCount: 0,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // finishScan + getScan
  // ---------------------------------------------------------------------------

  describe('finishScan', () => {
    it('sets status and finished_at, and persists rollups matching computeTotals', () => {
      const { scanId } = seedMixedScan();
      const totals = repo.computeTotals(scanId);

      repo.finishScan(scanId, totals);

      const scan = repo.getScan(scanId);
      expect(scan!.status).toBe('complete');
      expect(scan!.finished_at).not.toBeNull();
      expect(scan!.total_files).toBe(totals.totalFiles);
      expect(scan!.total_bytes).toBe(totals.totalBytes);
      expect(scan!.photo_count).toBe(totals.photoCount);
      expect(scan!.video_count).toBe(totals.videoCount);
      expect(scan!.exif_count).toBe(totals.exifCount);
      expect(scan!.gps_count).toBe(totals.gpsCount);
    });

    it('accepts a custom status (e.g. error)', () => {
      const scanId = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      const totals = repo.computeTotals(scanId);
      repo.finishScan(scanId, totals, 'error');
      expect(repo.getScan(scanId)!.status).toBe('error');
    });
  });

  // ---------------------------------------------------------------------------
  // coverageExtras
  // ---------------------------------------------------------------------------

  describe('coverageExtras', () => {
    it('counts capturedAtCount and metaErrorCount correctly', () => {
      const { scanId } = seedMixedScan();
      const extras = repo.coverageExtras(scanId);
      // capturedAt set on a1, a2, a4 = 3
      expect(extras.capturedAtCount).toBe(3);
      // metaError set on the 'bad.jpg' row only = 1
      expect(extras.metaErrorCount).toBe(1);
    });

    it('returns zeros when no rows carry those fields', () => {
      const scanId = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      repo.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/plain.jpg' }));
      const extras = repo.coverageExtras(scanId);
      expect(extras.capturedAtCount).toBe(0);
      expect(extras.metaErrorCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // bytesByKind
  // ---------------------------------------------------------------------------

  describe('bytesByKind', () => {
    it('sums photo and video bytes separately and mutually exclusively', () => {
      const { scanId } = seedMixedScan();
      const { photoBytes, videoBytes } = repo.bytesByKind(scanId);

      // photos: a1(5M) + a2(6M) + a3(2M) + a4(3M) + bad(null->0) = 16M
      expect(photoBytes).toBe(5_000_000 + 6_000_000 + 2_000_000 + 3_000_000);
      // video: v1 = 50M
      expect(videoBytes).toBe(50_000_000);
      // Mutual exclusivity: total should equal totalBytes from computeTotals
      const totals = repo.computeTotals(scanId);
      expect(photoBytes + videoBytes).toBe(totals.totalBytes);
    });
  });

  // ---------------------------------------------------------------------------
  // cameraBreakdown
  // ---------------------------------------------------------------------------

  describe('cameraBreakdown', () => {
    it('groups by (make, model) pair, ordered by count descending', () => {
      const scanId = repo.startScan({ trigger: 'cli', folderIds: [folderId] });

      // Apple iPhone 14 x3 (most frequent)
      for (let i = 0; i < 3; i++) {
        repo.insertScanFile(scanId, baseFile({
          folderId,
          filePath: `/tmp/apple${i}.jpg`,
          cameraMake: 'Apple',
          cameraModel: 'iPhone 14',
        }));
      }
      // Samsung Galaxy S21 x2
      for (let i = 0; i < 2; i++) {
        repo.insertScanFile(scanId, baseFile({
          folderId,
          filePath: `/tmp/samsung${i}.jpg`,
          cameraMake: 'Samsung',
          cameraModel: 'Galaxy S21',
        }));
      }
      // Canon EOS x1 (least frequent)
      repo.insertScanFile(scanId, baseFile({
        folderId,
        filePath: '/tmp/canon.jpg',
        cameraMake: 'Canon',
        cameraModel: 'EOS',
      }));

      const breakdown = repo.cameraBreakdown(scanId);
      expect(breakdown).toHaveLength(3);
      expect(breakdown[0]).toMatchObject({ make: 'Apple', model: 'iPhone 14', count: 3 });
      expect(breakdown[1]).toMatchObject({ make: 'Samsung', model: 'Galaxy S21', count: 2 });
      expect(breakdown[2]).toMatchObject({ make: 'Canon', model: 'EOS', count: 1 });
    });

    it('respects the limit parameter', () => {
      const scanId = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      repo.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/m1.jpg', cameraMake: 'A', cameraModel: 'X' }));
      repo.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/m2.jpg', cameraMake: 'B', cameraModel: 'Y' }));
      repo.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/m3.jpg', cameraMake: 'C', cameraModel: 'Z' }));

      const breakdown = repo.cameraBreakdown(scanId, 2);
      expect(breakdown).toHaveLength(2);
    });

    it('excludes rows with no camera make or model', () => {
      const scanId = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      repo.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/no-camera.jpg' }));
      repo.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/has-camera.jpg', cameraMake: 'Apple' }));

      const breakdown = repo.cameraBreakdown(scanId);
      expect(breakdown).toHaveLength(1);
      expect(breakdown[0].make).toBe('Apple');
    });
  });

  // ---------------------------------------------------------------------------
  // folderBreakdown
  // ---------------------------------------------------------------------------

  describe('folderBreakdown', () => {
    it('groups by folder_id with correct count and bytes across 2+ folders', () => {
      const { scanId, folder2Id } = seedMixedScan();

      const breakdown = repo.folderBreakdown(scanId);
      const forFolder1 = breakdown.find((b) => b.folderId === folderId)!;
      const forFolder2 = breakdown.find((b) => b.folderId === folder2Id)!;

      expect(forFolder1.count).toBe(5); // a1,a2,a3,a4,v1
      expect(forFolder1.bytes).toBe(5_000_000 + 6_000_000 + 2_000_000 + 3_000_000 + 50_000_000);

      expect(forFolder2.count).toBe(1); // bad.jpg
      expect(forFolder2.bytes).toBe(0); // size_bytes was null
    });
  });

  // ---------------------------------------------------------------------------
  // largestFiles
  // ---------------------------------------------------------------------------

  describe('largestFiles', () => {
    it('orders by size_bytes descending and excludes null-size rows', () => {
      const { scanId } = seedMixedScan();

      const largest = repo.largestFiles(scanId, 10);
      // 5 rows have non-null size_bytes (bad.jpg is excluded — null size)
      expect(largest).toHaveLength(5);
      expect(largest.map((f) => f.file_path)).not.toContain('/tmp/scan-testfolder2/bad.jpg');

      const sizes = largest.map((f) => f.size_bytes);
      const sorted = [...sizes].sort((a, b) => (b ?? 0) - (a ?? 0));
      expect(sizes).toEqual(sorted);
      expect(largest[0].size_bytes).toBe(50_000_000); // v1.mp4 is the biggest
    });

    it('respects the limit parameter', () => {
      const { scanId } = seedMixedScan();
      const largest = repo.largestFiles(scanId, 2);
      expect(largest).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // listScans / latestComplete
  // ---------------------------------------------------------------------------

  describe('listScans', () => {
    it('returns scans newest-first', () => {
      const id1 = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      const id2 = repo.startScan({ trigger: 'cli', folderIds: [folderId] });

      const scans = repo.listScans();
      expect(scans[0].id).toBe(id2);
      expect(scans[1].id).toBe(id1);
    });

    it('respects the limit parameter', () => {
      repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      repo.startScan({ trigger: 'cli', folderIds: [folderId] });

      const scans = repo.listScans(2);
      expect(scans).toHaveLength(2);
    });
  });

  describe('latestComplete', () => {
    it('returns null when no scan has status=complete', () => {
      repo.startScan({ trigger: 'cli', folderIds: [folderId] }); // stays 'running'
      expect(repo.latestComplete()).toBeNull();
    });

    it('returns the most recently completed scan', () => {
      const id1 = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      repo.finishScan(id1, repo.computeTotals(id1));

      const id2 = repo.startScan({ trigger: 'cli', folderIds: [folderId] }); // left running

      const id3 = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      repo.finishScan(id3, repo.computeTotals(id3));

      const latest = repo.latestComplete();
      expect(latest).not.toBeNull();
      expect(latest!.id).toBe(id3);
      void id2;
    });
  });

  // ---------------------------------------------------------------------------
  // listScanFiles
  // ---------------------------------------------------------------------------

  describe('listScanFiles', () => {
    it('returns all rows for a scan ordered by file_path', () => {
      const scanId = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      repo.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/zzz.jpg' }));
      repo.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/aaa.jpg' }));
      repo.insertScanFile(scanId, baseFile({ folderId, filePath: '/tmp/mmm.jpg' }));

      const files = repo.listScanFiles(scanId);
      expect(files.map((f) => f.file_path)).toEqual(['/tmp/aaa.jpg', '/tmp/mmm.jpg', '/tmp/zzz.jpg']);
    });

    it('round-trips has_exif/has_gps booleans correctly (0/1 -> real booleans)', () => {
      const scanId = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      repo.insertScanFile(scanId, baseFile({
        folderId,
        filePath: '/tmp/bool-check.jpg',
        hasExif: true,
        hasGps: false,
      }));

      const [file] = repo.listScanFiles(scanId);
      expect(file.has_exif).toBe(true);
      expect(typeof file.has_exif).toBe('boolean');
      expect(file.has_gps).toBe(false);
      expect(typeof file.has_gps).toBe('boolean');
    });

    it('returns an empty array for a scan with no files', () => {
      const scanId = repo.startScan({ trigger: 'cli', folderIds: [folderId] });
      expect(repo.listScanFiles(scanId)).toEqual([]);
    });
  });
});
