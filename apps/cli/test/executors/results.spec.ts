/**
 * Each executor returns what the server handler's `nodeResultSchema` (the shared DTO of
 * @marinoscar/memoriahub-compute/dto) parses, over the real compute libraries where they are
 * installed and a local presigned-PUT stub (RETRO-C10, #616).
 */
import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  metadataExtractionResultSchema,
  thumbnailResultSchema,
  workflowExecuteBatchResultSchema,
} from '@marinoscar/memoriahub-compute/dto';
import sharp from 'sharp';

import { thumbnailRegenExecutor } from '../../src/executors/thumbnail.executor.js';
import { metadataExtractionExecutor } from '../../src/executors/metadata.executor.js';
import { workflowExecuteBatchExecutor } from '../../src/executors/workflow-execute-batch.executor.js';
import { makeContext } from './helpers.js';

let dir: string;
let png: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-exec-'));
  png = path.join(dir, 'in');
  fs.writeFileSync(png, await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#336699' } }).jpeg().toBuffer());
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('thumbnail_regen executor', () => {
  it('uploads to the key the SERVER chose and reports it', async () => {
    const puts: Array<{ url: string; bytes: number }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: Buffer }) => {
      puts.push({ url: String(url), bytes: init.body.length });
      return new Response(null, { status: 200 });
    }) as never;
    try {
      const { context, api } = makeContext({ type: 'thumbnail_regen', inputPath: png });
      const result = thumbnailResultSchema.parse(await thumbnailRegenExecutor.execute(context));
      expect(result.storageKey).toBe('node-outputs/job-1/obj-1');
      expect(Math.max(result.width, result.height)).toBe(800);
      expect(result.bytes).toBe(puts[0]!.bytes);
      expect(api.uploadCalls).toEqual([['node-1', 'job-1', 'image/jpeg', 'claim-1']]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('retries a throttled PUT and fails without echoing the presigned URL', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 403 })) as never;
    try {
      const { context } = makeContext({ type: 'thumbnail_regen', inputPath: png });
      const error = (await thumbnailRegenExecutor.execute(context).catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(/upload failed \(HTTP 403\)/);
      expect(error.message).not.toContain('sig=');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('refuses a job the engine gave no input file', async () => {
    const { context } = makeContext({ type: 'thumbnail_regen' });
    await expect(thumbnailRegenExecutor.execute(context)).rejects.toThrow(/no input file/);
  });
});

describe('metadata_extraction executor', () => {
  it('dispatches on the stored object\'s type and returns { exif, probe }', async () => {
    const { context } = makeContext({ type: 'metadata_extraction', inputPath: png, input: { objectId: 'o', size: '1', mimeType: 'image/jpeg' } });
    const result = metadataExtractionResultSchema.parse(await metadataExtractionExecutor.execute(context));
    expect(result.probe).toBeNull();
    expect(result.exif['width']).toBe(1600);
  });

  it('falls back to the payload mimeType, and names the problem when neither is given', async () => {
    const withParam = makeContext({ type: 'metadata_extraction', inputPath: png, params: { mimeType: 'image/jpeg' } });
    await expect(metadataExtractionExecutor.execute(withParam.context)).resolves.toBeDefined();
    const none = makeContext({ type: 'metadata_extraction', inputPath: png });
    await expect(metadataExtractionExecutor.execute(none.context)).rejects.toThrow(/mimeType/);
  });
});

describe('workflow_execute_batch executor', () => {
  it('declares the batch from the payload', async () => {
    const { context } = makeContext({
      type: 'workflow_execute_batch',
      params: { runId: 'run-1', itemIds: ['a', 'b'], actions: [{ type: 'archive' }] },
    });
    const result = workflowExecuteBatchResultSchema.parse(await workflowExecuteBatchExecutor.execute(context));
    expect(result.runId).toBe('run-1');
    expect(result.items.map((i) => i.mediaItemId)).toEqual(['a', 'b']);
  });
});

void jest;
