import { describe, it, expect, vi } from 'vitest';

const post = vi.fn();
vi.mock('../../src/core/headless/index.js', () => ({ api: { post: (...a: unknown[]) => post(...a) } }));

import { repairThumbnails } from '../../src/media/headless/services/thumbnail.js';

describe('repairThumbnails', () => {
  it('posts to the admin repair route and returns the queued job', async () => {
    post.mockResolvedValueOnce({ jobId: 'job-1', status: 'pending' });
    await expect(repairThumbnails()).resolves.toEqual({ jobId: 'job-1', status: 'pending' });
    expect(post).toHaveBeenCalledWith('/admin/media/thumbnails/repair', {});
  });
});
