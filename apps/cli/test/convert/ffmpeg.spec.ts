/**
 * test/convert/ffmpeg.spec.ts — Unit tests for the ffmpeg wrapper.
 *
 * `buildConvertArgs` is pure and tested directly. `detectFfmpeg` and
 * `convertFile` are exercised with `node:child_process` mocked via
 * jest.unstable_mockModule — the fake `spawn` writes a real temp file so the
 * wrapper's real fs verify/rename logic runs against the actual filesystem.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Mock node:child_process (spawn + execFile)
// ---------------------------------------------------------------------------

interface SpawnConfig {
  remux: 'ok' | 'fail';
  reencode: 'ok' | 'fail';
  /** Emit 'error' with this code instead of a normal close (e.g. ENOENT). */
  spawnError?: string;
}

let spawnConfig: SpawnConfig = { remux: 'ok', reencode: 'ok' };
const spawnCalls: string[][] = [];

const spawnMock = jest.fn((_bin: string, args: string[]) => {
  spawnCalls.push(args);
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  child.stderr = new EventEmitter();

  const mode = args.includes('libx264') ? 'reencode' : 'remux';
  const tmpOut = args[args.length - 1];

  setImmediate(() => {
    if (spawnConfig.spawnError) {
      const err = Object.assign(new Error('spawn failed'), { code: spawnConfig.spawnError });
      child.emit('error', err);
      return;
    }
    const outcome = mode === 'reencode' ? spawnConfig.reencode : spawnConfig.remux;
    if (outcome === 'ok') {
      fs.writeFileSync(tmpOut, 'fake-mp4-bytes');
      child.emit('close', 0);
    } else {
      child.stderr.emit('data', Buffer.from('some ffmpeg error\n'));
      child.emit('close', 1);
    }
  });

  return child;
});

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;
let execFileImpl: (bin: string, args: string[], opts: unknown, cb: ExecFileCb) => void = (
  _bin,
  _args,
  _opts,
  cb,
) => cb(null, 'ffmpeg version 6.1.1 Copyright (c) 2000-2024\n', '');

const execFileMock = jest.fn(
  (bin: string, args: string[], opts: unknown, cb: ExecFileCb) => execFileImpl(bin, args, opts, cb),
);

jest.unstable_mockModule('node:child_process', () => ({
  spawn: spawnMock,
  execFile: execFileMock,
}));

const {
  buildConvertArgs,
  detectFfmpeg,
  convertFile,
  ffmpegInstallHint,
  FfmpegNotFoundError,
  _resetDetectCache,
  DEFAULT_CRF,
} = await import('../../src/convert/ffmpeg.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('convert/ffmpeg', () => {
  describe('buildConvertArgs', () => {
    it('builds a lossless remux (copy video, transcode audio, faststart)', () => {
      const args = buildConvertArgs('/in.mov', '/out.mp4.partial', 'remux');
      expect(args).toEqual([
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', '/in.mov',
        '-c:v', 'copy', '-c:a', 'aac', '-map_metadata', '0', '-movflags', '+faststart',
        '/out.mp4.partial',
      ]);
    });

    it('builds an H.264 re-encode with the default CRF', () => {
      const args = buildConvertArgs('/in.avi', '/out.mp4.partial', 'reencode');
      expect(args).toContain('libx264');
      expect(args).toContain('-crf');
      expect(args[args.indexOf('-crf') + 1]).toBe(String(DEFAULT_CRF));
      expect(args).toContain('+faststart');
      expect(args[args.length - 1]).toBe('/out.mp4.partial');
    });

    it('honors a custom CRF', () => {
      const args = buildConvertArgs('/in.avi', '/out.mp4.partial', 'reencode', { crf: 28 });
      expect(args[args.indexOf('-crf') + 1]).toBe('28');
    });
  });

  describe('ffmpegInstallHint', () => {
    it('gives a platform-specific hint', () => {
      expect(ffmpegInstallHint('darwin')).toMatch(/brew install ffmpeg/);
      expect(ffmpegInstallHint('win32')).toMatch(/winget|choco/);
      expect(ffmpegInstallHint('linux')).toMatch(/apt install ffmpeg/);
    });
  });

  describe('detectFfmpeg', () => {
    beforeEach(() => {
      _resetDetectCache();
    });

    it('resolves available:true and parses the version', async () => {
      execFileImpl = (_bin, _args, _opts, cb) =>
        cb(null, 'ffmpeg version 6.1.1 Copyright\n', '');
      const info = await detectFfmpeg();
      expect(info.available).toBe(true);
      expect(info.version).toBe('6.1.1');
    });

    it('resolves available:false on ENOENT', async () => {
      execFileImpl = (_bin, _args, _opts, cb) =>
        cb(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', '');
      const info = await detectFfmpeg();
      expect(info.available).toBe(false);
    });
  });

  describe('convertFile', () => {
    let tmpDir: string;
    let src: string;
    let target: string;

    beforeEach(() => {
      spawnConfig = { remux: 'ok', reencode: 'ok' };
      spawnCalls.length = 0;
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-convert-ffmpeg-'));
      src = path.join(tmpDir, 'clip.mov');
      fs.writeFileSync(src, 'source-bytes');
      target = path.join(tmpDir, 'clip.mp4');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('remuxes successfully on the first attempt', async () => {
      const result = await convertFile(src, target);
      expect(result.mode).toBe('remux');
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.existsSync(`${target}.partial`)).toBe(false);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]).toContain('copy');
    });

    it('falls back to re-encode when the remux fails', async () => {
      spawnConfig = { remux: 'fail', reencode: 'ok' };
      const result = await convertFile(src, target);
      expect(result.mode).toBe('reencode');
      expect(fs.existsSync(target)).toBe(true);
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[0]).toContain('copy');
      expect(spawnCalls[1]).toContain('libx264');
    });

    it('forces re-encode (single attempt) when forceReencode is set', async () => {
      const result = await convertFile(src, target, { forceReencode: true });
      expect(result.mode).toBe('reencode');
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]).toContain('libx264');
    });

    it('rejects and cleans up the temp file when both attempts fail', async () => {
      spawnConfig = { remux: 'fail', reencode: 'fail' };
      await expect(convertFile(src, target)).rejects.toThrow(/ffmpeg exited/);
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.existsSync(`${target}.partial`)).toBe(false);
    });

    it('rejects with FfmpegNotFoundError when spawn errors ENOENT', async () => {
      spawnConfig = { remux: 'ok', reencode: 'ok', spawnError: 'ENOENT' };
      await expect(convertFile(src, target)).rejects.toBeInstanceOf(FfmpegNotFoundError);
    });
  });
});

void jest;
