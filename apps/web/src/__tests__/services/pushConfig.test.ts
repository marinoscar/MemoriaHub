/**
 * `services/pushConfig.ts` — epic #481, issue #487. Asserts each call hits the
 * route and body the API's `PushConfigController` expects, including the two
 * DIFFERENT confirmation literals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

import { api } from '../../services/api';
import {
  REMOVE_CONFIRMATION,
  ROTATE_CONFIRMATION,
  generatePushConfig,
  getPushConfig,
  removePushConfig,
  rotatePushConfig,
  sendPushTest,
  updatePushConfig,
} from '../../services/pushConfig';

describe('services/pushConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses two different confirmation words', () => {
    expect(ROTATE_CONFIRMATION).toBe('ROTATE');
    expect(REMOVE_CONFIRMATION).toBe('REMOVE');
  });

  it('GETs the admin view', async () => {
    await getPushConfig();
    expect(api.get).toHaveBeenCalledWith('/admin/push-config');
  });

  it('PUTs a partial update', async () => {
    await updatePushConfig({ enabled: true, subject: null });
    expect(api.put).toHaveBeenCalledWith('/admin/push-config', { enabled: true, subject: null });
  });

  it('POSTs generate with the optional subject', async () => {
    await generatePushConfig({ subject: 'mailto:a@b.co' });
    expect(api.post).toHaveBeenCalledWith('/admin/push-config/generate', { subject: 'mailto:a@b.co' });
    await generatePushConfig();
    expect(api.post).toHaveBeenLastCalledWith('/admin/push-config/generate', {});
  });

  it('POSTs rotate with the ROTATE literal', async () => {
    await rotatePushConfig();
    expect(api.post).toHaveBeenCalledWith('/admin/push-config/rotate', { confirmation: 'ROTATE' });
  });

  it('DELETEs with the REMOVE literal in the body', async () => {
    await removePushConfig();
    expect(api.delete).toHaveBeenCalledWith('/admin/push-config', {
      body: JSON.stringify({ confirmation: 'REMOVE' }),
    });
  });

  it('POSTs the test with this browser endpoint and key', async () => {
    await sendPushTest({ endpoint: 'https://push.example/x', applicationServerKey: 'abc' });
    expect(api.post).toHaveBeenCalledWith('/admin/push-config/test', {
      endpoint: 'https://push.example/x',
      applicationServerKey: 'abc',
    });
  });
});
