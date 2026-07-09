/**
 * test/convert/error-report.spec.ts — Unit tests for convert error grouping and
 * report file writing. HOME is redirected to a temp dir so writeConvertErrorReport
 * writes under a throwaway ~/.memoriahub/exports.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  summarizeConvertErrors,
  writeConvertErrorReport,
  type ConvertErrorEntry,
} from '../../src/convert/error-report.js';

describe('convert/error-report', () => {
  describe('summarizeConvertErrors', () => {
    it('groups identical errors (path/number-normalized) and sorts by count desc', () => {
      const entries: ConvertErrorEntry[] = [
        { filePath: '/a/one.mov', error: "Unable to find a suitable output format for '/a/one.mov.partial'" },
        { filePath: '/a/two.mts', error: "Unable to find a suitable output format for '/a/two.mts.partial'" },
        { filePath: '/a/three.avi', error: 'ffmpeg exited with code 1: some other error' },
      ];
      const groups = summarizeConvertErrors(entries);
      expect(groups).toHaveLength(2);
      expect(groups[0].count).toBe(2);
      expect(groups[0].message).toContain('Unable to find a suitable output format');
      expect(groups[0].examples.length).toBeGreaterThan(0);
      expect(groups[1].count).toBe(1);
    });
  });

  describe('writeConvertErrorReport', () => {
    let tmpHome: string;
    let originalHome: string | undefined;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-convert-report-'));
      originalHome = process.env.HOME;
      process.env.HOME = tmpHome;
    });

    afterEach(() => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('writes a report file containing the grouped summary and per-file detail', () => {
      const entries: ConvertErrorEntry[] = [
        { filePath: '/vids/a.mov', error: 'ffmpeg exited with code 1: boom' },
        { filePath: '/vids/b.mts', error: 'ffmpeg exited with code 1: boom' },
      ];
      const ts = new Date('2026-07-09T12:00:00.000Z');
      const outPath = writeConvertErrorReport(entries, ts);

      expect(fs.existsSync(outPath)).toBe(true);
      expect(path.basename(outPath)).toMatch(/^convert-errors-.*\.log$/);

      const content = fs.readFileSync(outPath, 'utf8');
      expect(content).toContain('Failed files: 2');
      expect(content).toContain('/vids/a.mov');
      expect(content).toContain('/vids/b.mts');
      expect(content).toContain('boom');
      expect(content).toMatch(/2\s+ffmpeg exited/);
    });
  });
});
