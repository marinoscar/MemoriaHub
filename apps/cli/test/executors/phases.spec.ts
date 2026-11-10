/**
 * test/executors/phases.spec.ts (RETRO-T4, #629)
 *
 * The executors record their meaningful steps as `job.app.<phase>` spans through
 * `context.phase`. Pins that every phase name is valid, every attribute is a registered key with a
 * bounded value (a non-negative integer, or a token with no `/`, `:` or space), that a bare context
 * (no `phase`) still runs and returns the same result, and that the vitals are within the platform's
 * limits. Heavy libraries are mocked, as in the neighbouring specs.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NODE_APP_SPAN_NAME_PATTERN } from '@marinoscar/platform-cli/node';

import { makeContext } from './helpers.js';

jest.unstable_mockModule('@marinoscar/memoriahub-compute/image', () => ({
  prepareImageForProcessing: async (buffer: Buffer) => ({ buffer, width: 640, height: 480 }),
}));
jest.unstable_mockModule('@marinoscar/memoriahub-compute/face-compreface', () => ({
  detectComprefaceFaces: async () => [
    { boundingBox: { x: 1, y: 2, w: 3, h: 4 }, confidence: 0.9, embedding: [0.1, 0.2], landmarks: [] },
  ],
  COMPREFACE_MODEL_VERSION: 'compreface-test',
  COMPREFACE_PROVIDER_KEY: 'compreface',
}));
jest.unstable_mockModule('@marinoscar/memoriahub-compute/metadata', () => ({
  probeVideo: async () => ({ streams: [{ codec_type: 'video', codec_name: 'h264' }], format: {} }),
  extractContainerMetadata: () => ({ durationMs: 4000, codec: 'h264', formatTags: {}, streamTags: {} }),
  extractExif: async () => ({}),
  extractDimensions: async () => ({ width: 800, height: 600 }),
}));
jest.unstable_mockModule('@marinoscar/memoriahub-compute/video', () => ({
  extractFrames: async () => [
    { buffer: Buffer.from('f1'), timestampMs: 0 },
    { buffer: Buffer.from('f2'), timestampMs: 1000 },
  ],
  extractFramesAt: async () => [],
  extractPosterFrame: async () => Buffer.from('poster'),
}));
jest.unstable_mockModule('@marinoscar/memoriahub-compute/face-video', () => ({
  clusterFaceDetections: (detections: unknown[]) => detections.slice(0, 1).map((d) => ({ representative: d, allTimestampsMs: [0] })),
  buildFaceCropThumbnail: async () => Buffer.from('thumb'),
  DEFAULT_FACE_CLUSTER_THRESHOLD: 0.45,
}));
jest.unstable_mockModule('@marinoscar/memoriahub-compute/dhash', () => ({ computeDHash: async () => '123' }));
jest.unstable_mockModule('@marinoscar/memoriahub-compute/clip', () => ({
  createClipSession: async () => ({}),
  embedImageWithSession: async () => new Array(512).fill(0),
  releaseClipSession: async () => undefined,
  DEFAULT_CLIP_RECYCLE_AFTER: 1000,
  VISUAL_EMBEDDING_MODEL_TAG: 'clip-test',
}));
jest.unstable_mockModule('../../src/executors/models.js', () => ({
  clipModelPath: () => path.join(os.tmpdir(), 'mh-phases-clip.onnx'),
  resolveModelsDirectory: () => os.tmpdir(),
}));
jest.unstable_mockModule('@marinoscar/memoriahub-compute/geo', () => ({
  fetchGoogleReverse: async () => ({}),
  fetchNominatim: async () => ({}),
  mapGoogleResponse: () => ({ country: 'C' }),
  mapNominatimResponse: () => ({ country: 'N' }),
}));

const { faceDetectionExecutor } = await import('../../src/executors/face-detection.executor.js');
const { videoFaceDetectionExecutor } = await import('../../src/executors/video-face-detection.executor.js');
const { duplicateDetectionExecutor } = await import('../../src/executors/duplicate-detection.executor.js');
const { metadataExtractionExecutor } = await import('../../src/executors/metadata.executor.js');
const { geocodeExecutor } = await import('../../src/executors/geocode.executor.js');
const { workflowExecuteBatchExecutor } = await import('../../src/executors/workflow-execute-batch.executor.js');

interface Recorded {
  name: string;
  attrs: Record<string, unknown>;
}

const REGISTERED = ['bytes', 'frames', 'faces', 'width', 'height', 'ocrFrames', 'embeddingDims', 'actions', 'codec', 'geoProvider'];

function recorder(): { phase: unknown; spans: Recorded[] } {
  const spans: Recorded[] = [];
  const phase = async <T,>(name: string, work: () => Promise<T>, attributes?: unknown): Promise<T> => {
    const result = await work();
    const attrs = typeof attributes === 'function' ? (attributes as (r: T) => unknown)(result) : attributes;
    spans.push({ name, attrs: Object.fromEntries(Object.entries((attrs as object) ?? {}).filter(([, v]) => v !== undefined)) });
    return result;
  };
  return { phase, spans };
}

function expectBounded(spans: Recorded[]): void {
  for (const span of spans) {
    expect(span.name).toMatch(NODE_APP_SPAN_NAME_PATTERN);
    for (const [key, value] of Object.entries(span.attrs)) {
      expect(REGISTERED).toContain(key);
      if (typeof value === 'string') expect(value).toMatch(/^[A-Za-z0-9_.+-]{1,128}$/);
      else expect(Number.isInteger(value) && (value as number) >= 0).toBe(true);
    }
  }
}

let tmp: string;
let input: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-phases-'));
  input = path.join(tmp, 'in.bin');
  fs.writeFileSync(input, Buffer.from('bytes'));
  fs.writeFileSync(path.join(os.tmpdir(), 'mh-phases-clip.onnx'), 'x');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('executor phase spans', () => {
  it('face_detection: decode, compreface_detect', async () => {
    const { phase, spans } = recorder();
    const { context } = makeContext({ type: 'face_detection', inputPath: input, phase } as never);
    await faceDetectionExecutor.execute(context);
    expect(spans.map((s) => s.name)).toEqual(['job.app.decode', 'job.app.compreface_detect']);
    expect(spans[0]?.attrs).toEqual({ width: 640, height: 480 });
    expect(spans[1]?.attrs).toEqual({ faces: 1 });
    expectBounded(spans);
  });

  it('video_face_detection: probe, frames_extract, compreface_detect, dedup, thumbnails stay one span per step', async () => {
    const { phase, spans } = recorder();
    const { context } = makeContext({ type: 'video_face_detection', inputPath: input, phase } as never);
    await videoFaceDetectionExecutor.execute(context);
    expect(spans.map((s) => s.name)).toEqual([
      'job.app.probe',
      'job.app.frames_extract',
      'job.app.compreface_detect',
      'job.app.dedup',
    ]);
    expect(spans[0]?.attrs).toEqual({ codec: 'h264' });
    expect(spans[1]?.attrs).toEqual({ frames: 2 });
    expectBounded(spans);
  });

  it('duplicate_detection: dhash, clip_embed', async () => {
    const { phase, spans } = recorder();
    const { context } = makeContext({ type: 'duplicate_detection', inputPath: input, phase } as never);
    await duplicateDetectionExecutor.execute(context);
    expect(spans.map((s) => s.name)).toEqual(['job.app.dhash', 'job.app.clip_embed']);
    expect(spans[1]?.attrs).toEqual({ embeddingDims: 512 });
    expectBounded(spans);
  });

  it('metadata_extraction: exif and decode for an image, probe for a video', async () => {
    const image = recorder();
    await metadataExtractionExecutor.execute(
      makeContext({ type: 'metadata_extraction', inputPath: input, input: { mimeType: 'image/jpeg' }, phase: image.phase } as never).context,
    );
    expect(image.spans.map((s) => s.name)).toEqual(['job.app.exif', 'job.app.decode']);
    const video = recorder();
    await metadataExtractionExecutor.execute(
      makeContext({ type: 'metadata_extraction', inputPath: input, input: { mimeType: 'video/mp4' }, phase: video.phase } as never).context,
    );
    expect(video.spans.map((s) => s.name)).toEqual(['job.app.probe']);
    expectBounded([...image.spans, ...video.spans]);
  });

  it('geocode: one span carrying the provider token, never a coordinate', async () => {
    const { phase, spans } = recorder();
    await geocodeExecutor.execute(makeContext({ type: 'geocode', params: { lat: 9.9, lng: -84.1 }, phase } as never).context);
    expect(spans).toEqual([{ name: 'job.app.geocode', attrs: { geoProvider: 'google' } }]);
    expectBounded(spans);
  });

  it('workflow_execute_batch: workflow_intent with the action count', async () => {
    const { phase, spans } = recorder();
    const params = { runId: 'r1', itemIds: ['a', 'b'], actions: [{ type: 'archive' }, { type: 'tag' }] };
    await workflowExecuteBatchExecutor.execute(makeContext({ type: 'workflow_execute_batch', params, phase } as never).context);
    expect(spans).toEqual([{ name: 'job.app.workflow_intent', attrs: { actions: 2 } }]);
  });

  it('runs and returns the same result on a bare context (no phase)', async () => {
    const withPhase = await workflowExecuteBatchExecutor.execute(
      makeContext({ type: 'workflow_execute_batch', params: { runId: 'r1', itemIds: ['a'] }, phase: recorder().phase } as never).context,
    );
    const bare = await workflowExecuteBatchExecutor.execute(
      makeContext({ type: 'workflow_execute_batch', params: { runId: 'r1', itemIds: ['a'] } }).context,
    );
    expect(bare).toEqual(withPhase);
  });

  it('every span name in the compute sources is a valid job.app name', () => {
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '../../src/executors/compute');
    const names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/'(job\.app\.[a-z_]+)'/g)].map((m) => m[1] as string));
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(name).toMatch(NODE_APP_SPAN_NAME_PATTERN);
  });
});

describe('executor vitals', () => {
  it('are finite numbers under valid keys, at most 16 across the node', () => {
    const all: Record<string, number> = {};
    for (const executor of [faceDetectionExecutor, videoFaceDetectionExecutor, duplicateDetectionExecutor]) {
      Object.assign(all, executor.vitals?.() ?? {});
    }
    for (const [key, value] of Object.entries(all)) {
      expect(key).toMatch(/^[a-z][a-z0-9_.]{1,47}$/);
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(Object.keys(all).length).toBeLessThanOrEqual(16);
    expect(Object.keys(all)).toContain('clip.session.embeds');
  });
});
