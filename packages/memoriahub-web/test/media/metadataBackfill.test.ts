import { describe, it, expect, vi } from 'vitest';

const post = vi.fn();
vi.mock('../../src/core/headless/index.js', () => ({ api: { post: (...a: unknown[]) => post(...a) } }));

import { runGlobalMetadataBackfill } from '../../src/media/headless/services/metadata.js';

describe('runGlobalMetadataBackfill', () => {
  it('posts an empty body by default and returns the counts', async () => {
    post.mockResolvedValueOnce({ enqueued: 3, circles: 2 });
    await expect(runGlobalMetadataBackfill()).resolves.toEqual({ enqueued: 3, circles: 2 });
    expect(post).toHaveBeenCalledWith('/admin/metadata/backfill', {});
  });

  it('forwards the range and force flag', async () => {
    post.mockResolvedValueOnce({ enqueued: 0, circles: 1 });
    await runGlobalMetadataBackfill({ from: '2026-01-01', force: true });
    expect(post).toHaveBeenLastCalledWith('/admin/metadata/backfill', { from: '2026-01-01', force: true });
  });
});
