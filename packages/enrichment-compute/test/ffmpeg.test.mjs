/**
 * Unit tests for @memoriahub/enrichment-compute/ffmpeg — the in-house
 * spawn() wrapper that replaced the deprecated fluent-ffmpeg dependency
 * (issue #219, epic #214).
 *
 * THE ARGV TESTS BELOW ARE THE PARITY GUARD. Every ffmpeg invocation in this
 * monorepo runs on BOTH the API server and distributed worker nodes, and the
 * two must be numerically identical (docs/specs/distributed-nodes.md §7).
 * The four expected argv arrays here were captured from the real
 * fluent-ffmpeg@2.1.3 via `FfmpegCommand#_getArguments()` for the exact chains
 * this codebase used, and were additionally verified to produce byte-identical
 * output frames from a real ffmpeg run. If a future refactor moves `-ss` after
 * `-i` (switching ffmpeg from fast input seek to exact output seek, landing on
 * a DIFFERENT frame), reorders the flags, or drops `-y`, these tests fail.
 * Do not "fix" them by updating the expectation — re-derive the change.
 *
 * MOCK STRATEGY — no module mocking:
 *
 * Unlike the fluent-ffmpeg era (see the header comments in video.test.mjs /
 * heic.test.mjs, which pre-seeded the CJS `require.cache` with a fake module
 * because `node --test` offers no module-mock hoisting), the wrapper exposes
 * an explicit `__setSpawnForTests()` seam. `node:child_process` is a builtin
 * that cannot be require.cache-swapped the same way, and a documented seam is
 * both simpler and more honest than mocking a builtin. Tests install a fake
 * spawn returning a scripted EventEmitter that quacks like a ChildProcess.
 *
 * These tests import the package via its `exports` map, so they exercise the
 * BUILT dist/esm output — run `npm run build` after editing src/ffmpeg/index.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const {
  buildFrameExtractionArgs,
  buildFfprobeArgs,
  parseFfprobeOutput,
  extractFfmpegError,
  resolveFfmpegPath,
  resolveFfprobePath,
  runFfmpeg,
  runFfprobe,
  __setSpawnForTests,
} = await import('@memoriahub/enrichment-compute/ffmpeg');

const IN = '/tmp/in.mp4';
const OUT = '/tmp/out.jpg';

// ===========================================================================
// ARGV PARITY — the four call shapes, exactly as fluent-ffmpeg emitted them
// ===========================================================================

test('argv parity: seekInput(s).frames(1).output(out) — `-ss` BEFORE `-i`', () => {
  assert.deepEqual(buildFrameExtractionArgs({ input: IN, output: OUT, seekSecs: 1 }), [
    '-ss',
    '1',
    '-i',
    IN,
    '-y',
    '-vframes',
    '1',
    OUT,
  ]);
});

test('argv parity: a 0-second seek still emits `-ss 0` (0 is not treated as absent)', () => {
  assert.deepEqual(buildFrameExtractionArgs({ input: IN, output: OUT, seekSecs: 0 }), [
    '-ss',
    '0',
    '-i',
    IN,
    '-y',
    '-vframes',
    '1',
    OUT,
  ]);
});

test('argv parity: videoFilters("thumbnail").frames(1).output(out) — no seek, `-filter:v` last', () => {
  assert.deepEqual(
    buildFrameExtractionArgs({ input: IN, output: OUT, videoFilter: 'thumbnail' }),
    ['-i', IN, '-y', '-vframes', '1', '-filter:v', 'thumbnail', OUT],
  );
});

test('argv parity: frames(1).output(out) — the HEIC transcode shape, no seek and no filter', () => {
  assert.deepEqual(buildFrameExtractionArgs({ input: '/tmp/in.heic', output: OUT }), [
    '-i',
    '/tmp/in.heic',
    '-y',
    '-vframes',
    '1',
    OUT,
  ]);
});

test('argv parity: ffprobe uses the DEFAULT output format (never -print_format json)', () => {
  // ffprobe's JSON writer emits most numerics as strings; the INI-ish default
  // is what parseFfprobeOutput coerces to real numbers, and those values are
  // persisted into storage_object.metadata._processing.
  const args = buildFfprobeArgs(IN);
  assert.deepEqual(args, ['-show_streams', '-show_format', IN]);
  assert.equal(args.includes('-print_format'), false);
  assert.equal(args.includes('-of'), false);
});

test('fractional seek seconds are stringified, not rounded', () => {
  assert.deepEqual(buildFrameExtractionArgs({ input: IN, output: OUT, seekSecs: 2.5 }).slice(0, 2), [
    '-ss',
    '2.5',
  ]);
});

test('a null/undefined seekSecs emits no -ss at all', () => {
  assert.equal(
    buildFrameExtractionArgs({ input: IN, output: OUT, seekSecs: null }).includes('-ss'),
    false,
  );
  assert.equal(
    buildFrameExtractionArgs({ input: IN, output: OUT, seekSecs: undefined }).includes('-ss'),
    false,
  );
});

// ===========================================================================
// Binary path resolution (FFMPEG_PATH / FFPROBE_PATH must keep working)
// ===========================================================================

test('binary resolution honours FFMPEG_PATH / FFPROBE_PATH, else falls back to a PATH lookup', () => {
  const savedFfmpeg = process.env.FFMPEG_PATH;
  const savedFfprobe = process.env.FFPROBE_PATH;
  try {
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
    assert.equal(resolveFfmpegPath(), 'ffmpeg');
    assert.equal(resolveFfprobePath(), 'ffprobe');

    process.env.FFMPEG_PATH = '/opt/custom/ffmpeg';
    process.env.FFPROBE_PATH = '/opt/custom/ffprobe';
    assert.equal(resolveFfmpegPath(), '/opt/custom/ffmpeg');
    assert.equal(resolveFfprobePath(), '/opt/custom/ffprobe');

    // An empty/whitespace value must not produce an unrunnable empty command.
    process.env.FFMPEG_PATH = '   ';
    assert.equal(resolveFfmpegPath(), 'ffmpeg');
  } finally {
    if (savedFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = savedFfmpeg;
    if (savedFfprobe === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = savedFfprobe;
  }
});

// ===========================================================================
// ffprobe output parsing — ported verbatim from fluent-ffmpeg lib/ffprobe.js
// ===========================================================================

const SAMPLE_FFPROBE_OUTPUT = [
  '[STREAM]',
  'index=0',
  'codec_name=h264',
  'codec_type=video',
  'width=1920',
  'height=1080',
  'duration=12.400000',
  'bit_rate=N/A',
  'DISPOSITION:default=1',
  'TAG:language=eng',
  'TAG:rotate=90',
  '[/STREAM]',
  '[STREAM]',
  'index=1',
  'codec_name=aac',
  'codec_type=audio',
  '[/STREAM]',
  '[FORMAT]',
  'filename=/tmp/sample.mp4',
  'nb_streams=2',
  'format_name=mov,mp4,m4a,3gp,3g2,mj2',
  'duration=12.400000',
  'size=102400',
  'TAG:title=My Title',
  'TAG:comment=hash #fyp',
  '[/FORMAT]',
  '',
].join('\n');

test('parseFfprobeOutput builds the { streams, format, chapters } shape', () => {
  const data = parseFfprobeOutput(SAMPLE_FFPROBE_OUTPUT);
  assert.equal(data.streams.length, 2);
  assert.deepEqual(data.chapters, []);
  assert.equal(data.format.format_name, 'mov,mp4,m4a,3gp,3g2,mj2');
});

test('parseFfprobeOutput coerces unsigned numeric values to NUMBERS, not strings', () => {
  // This is exactly why -print_format json was rejected: its writer would give
  // width/height/duration back as strings, silently changing what gets
  // persisted into storage_object.metadata._processing.
  const data = parseFfprobeOutput(SAMPLE_FFPROBE_OUTPUT);
  const video = data.streams[0];
  assert.strictEqual(video.width, 1920);
  assert.strictEqual(video.height, 1080);
  assert.strictEqual(video.index, 0);
  assert.strictEqual(data.format.duration, 12.4);
  assert.strictEqual(data.format.size, 102400);
});

test('parseFfprobeOutput leaves non-numeric values as raw strings', () => {
  const data = parseFfprobeOutput(SAMPLE_FFPROBE_OUTPUT);
  assert.strictEqual(data.streams[0].codec_name, 'h264');
  assert.strictEqual(data.streams[0].bit_rate, 'N/A');
});

test('parseFfprobeOutput folds legacy TAG:/DISPOSITION: keys and keeps TAG values as strings', () => {
  const data = parseFfprobeOutput(SAMPLE_FFPROBE_OUTPUT);
  const video = data.streams[0];

  assert.deepEqual(video.tags, { language: 'eng', rotate: '90' });
  // A numeric-looking TAG: value must NOT be coerced — the TAG: prefix opts out.
  assert.strictEqual(video.tags.rotate, '90');
  assert.equal('TAG:language' in video, false, 'the original TAG: key must be deleted');

  assert.deepEqual(video.disposition, { default: 1 });
  assert.equal('DISPOSITION:default' in video, false);

  assert.deepEqual(data.format.tags, { title: 'My Title', comment: 'hash #fyp' });
});

test('parseFfprobeOutput handles CRLF, blank lines and an empty input', () => {
  const crlf = SAMPLE_FFPROBE_OUTPUT.replace(/\n/g, '\r\n');
  assert.deepEqual(parseFfprobeOutput(crlf), parseFfprobeOutput(SAMPLE_FFPROBE_OUTPUT));
  assert.deepEqual(parseFfprobeOutput(''), { streams: [], format: {}, chapters: [] });
});

test('parseFfprobeOutput collects [CHAPTER] blocks', () => {
  const data = parseFfprobeOutput(
    ['[CHAPTER]', 'id=0', 'start_time=0.000000', '[/CHAPTER]'].join('\n'),
  );
  assert.equal(data.chapters.length, 1);
  assert.strictEqual(data.chapters[0].id, 0);
});

test('extractFfmpegError keeps only the trailing non-banner stderr lines', () => {
  const stderr = [
    'ffmpeg version 6.1.1 Copyright (c) 2000-2023',
    '  built with gcc 13',
    '[mov,mp4 @ 0x1] moov atom not found',
    '/tmp/broken.mp4: Invalid data found when processing input',
  ].join('\n');
  assert.equal(
    extractFfmpegError(stderr),
    '/tmp/broken.mp4: Invalid data found when processing input',
  );
});

// ===========================================================================
// Process runner — spawn seam
// ===========================================================================

/**
 * A minimal ChildProcess stand-in: an EventEmitter with `stdout`/`stderr`
 * readable streams, a `stdin` emitter, and a `kill()` recorder.
 */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  child.finish = ({ code = 0, signal = null, stdout = '', stderr = '' } = {}) => {
    setImmediate(() => {
      if (stdout) child.stdout.push(stdout);
      child.stdout.push(null);
      if (stderr) child.stderr.push(stderr);
      child.stderr.push(null);
      child.emit('close', code, signal);
    });
  };
  return child;
}

/** Install a fake spawn for one test; returns { calls, restore }. */
function installFakeSpawn(handler) {
  const calls = [];
  __setSpawnForTests((command, args, options) => {
    const child = makeFakeChild();
    calls.push({ command, args: [...args], options, child });
    handler(child, calls.length - 1);
    return child;
  });
  return { calls, restore: () => __setSpawnForTests(null) };
}

test('runFfmpeg resolves on a clean exit and spawns the resolved binary with the given argv', async () => {
  const { calls, restore } = installFakeSpawn((child) => child.finish({ code: 0 }));
  try {
    const args = buildFrameExtractionArgs({ input: IN, output: OUT, seekSecs: 1 });
    await runFfmpeg(args);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, resolveFfmpegPath());
    assert.deepEqual(calls[0].args, args);
    assert.equal(calls[0].options.windowsHide, true);
  } finally {
    restore();
  }
});

test('runFfmpeg rejects with fluent-ffmpeg\'s message shape on a non-zero exit', async () => {
  const { restore } = installFakeSpawn((child) =>
    child.finish({
      code: 1,
      stderr:
        'ffmpeg version 6.1.1\n  configuration: --x\n[mov @ 0x1] noise\n/tmp/in.mp4: Invalid data found when processing input\n',
    }),
  );
  try {
    await assert.rejects(
      () => runFfmpeg(['-i', IN, OUT]),
      (err) => {
        assert.equal(
          err.message,
          'ffmpeg exited with code 1: /tmp/in.mp4: Invalid data found when processing input',
        );
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('runFfmpeg surfaces a spawn error (e.g. ENOENT when no ffmpeg binary exists)', async () => {
  const { restore } = installFakeSpawn((child) => {
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })));
  });
  try {
    await assert.rejects(() => runFfmpeg(['-i', IN, OUT]), /ENOENT/);
  } finally {
    restore();
  }
});

test('runFfmpeg SIGKILLs (never SIGTERM) a hung process and rejects with the caller\'s timeout message', async () => {
  const { calls, restore } = installFakeSpawn(() => {
    /* never settles */
  });
  try {
    await assert.rejects(
      () => runFfmpeg(['-i', IN, OUT], { timeoutMs: 20, timeoutMessage: 'ffmpeg frame extraction timed out after 20ms' }),
      (err) => {
        assert.equal(err.message, 'ffmpeg frame extraction timed out after 20ms');
        return true;
      },
    );
    assert.deepEqual(calls[0].child.killSignals, ['SIGKILL']);
  } finally {
    restore();
  }
});

test('runFfmpeg settles only once: the late close/error caused by the kill is a harmless no-op', async () => {
  const { calls, restore } = installFakeSpawn(() => {});
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const p = runFfmpeg(['-i', IN, OUT], { timeoutMs: 20 });
    await assert.rejects(() => p, /timed out/);

    // Simulate what a real SIGKILLed ffmpeg does afterwards.
    const child = calls[0].child;
    child.emit('error', new Error('late ffmpeg process error'));
    child.finish({ code: null, signal: 'SIGKILL' });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    restore();
  }
});

test('runFfprobe spawns ffprobe with the default-format argv and parses stdout', async () => {
  const { calls, restore } = installFakeSpawn((child) =>
    child.finish({ code: 0, stdout: SAMPLE_FFPROBE_OUTPUT }),
  );
  try {
    const data = await runFfprobe(IN);
    assert.equal(calls[0].command, resolveFfprobePath());
    assert.deepEqual(calls[0].args, ['-show_streams', '-show_format', IN]);
    assert.strictEqual(data.streams[0].width, 1920);
    assert.strictEqual(data.format.duration, 12.4);
  } finally {
    restore();
  }
});

test('runFfprobe appends stderr to the error message on a non-zero exit (fluent-ffmpeg behaviour)', async () => {
  const { restore } = installFakeSpawn((child) =>
    child.finish({ code: 1, stderr: '/tmp/missing.mp4: No such file or directory' }),
  );
  try {
    await assert.rejects(
      () => runFfprobe('/tmp/missing.mp4'),
      (err) => {
        assert.equal(
          err.message,
          'ffprobe exited with code 1\n/tmp/missing.mp4: No such file or directory',
        );
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('runFfprobe KILLS the hung ffprobe child on timeout (the gap fluent-ffmpeg could not close)', async () => {
  const { calls, restore } = installFakeSpawn(() => {
    /* never settles — a corrupt/truncated container */
  });
  try {
    await assert.rejects(
      () => runFfprobe(IN, { timeoutMs: 20, timeoutMessage: 'ffprobe timed out after 20ms' }),
      (err) => {
        assert.equal(err.message, 'ffprobe timed out after 20ms');
        return true;
      },
    );
    // fluent-ffmpeg's callback-only ffprobe() exposed no process handle, so
    // the old implementation could only race a timer and leave this orphaned.
    assert.deepEqual(calls[0].child.killSignals, ['SIGKILL']);
  } finally {
    restore();
  }
});
