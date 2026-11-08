import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../../services/api';
import { appGetBlob } from '../../platform/platformHost';

/** The binary GET the Doctor's support-bundle download goes through (RETRO-B1b, #602). */
describe('appGetBlob', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    api.setAccessToken('tok-1');
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    api.setAccessToken(null);
  });

  it('sends the bearer token and returns the body with its headers', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"a":1}', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="b.json"' } }),
    );

    const result = await appGetBlob('/admin/doctor/support-bundle');

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/admin\/doctor\/support-bundle$/);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-1');
    expect(await result.blob.text()).toBe('{"a":1}');
    expect(result.headers.get('content-disposition')).toContain('b.json');
  });

  it('refreshes once on a 401 and retries', async () => {
    const refresh = vi.spyOn(api, 'refreshToken').mockImplementation(async () => {
      api.setAccessToken('tok-2');
      return true;
    });
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const result = await appGetBlob('/admin/doctor/support-bundle');

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer tok-2');
    expect(await result.blob.text()).toBe('ok');
    refresh.mockRestore();
  });

  it('throws the API error for a failed response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }));

    await expect(appGetBlob('/admin/doctor/support-bundle')).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
  });
});
