import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registeredSettingsFeatures } from '@marinoscar/platform-web/settings/headless';

import '../../config/settingsFeatures';
import { api } from '../../services/api';
import { appPlatformApi, appPostBlob } from '../../platform/platformHost';
import { appTelemetryAdapters } from '../../platform/telemetryAdapters';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';

/** What the packaged telemetry pages take from MemoriaHub (RETRO-T2, #625). */
describe('appTelemetryAdapters', () => {
  it('reports AI off and no assistant models until RETRO-E4 (the assistant shows "AI disabled")', () => {
    expect(appTelemetryAdapters.useAiEnabled()).toEqual({ enabled: false, isLoading: false });
    expect(appTelemetryAdapters.useAssistantModels()).toEqual({ models: [], isLoading: false, error: null });
    expect(appTelemetryAdapters.Spinner).toBe(LoadingSpinner);
  });

  it('registers the telemetry settings feature beside orgs', () => {
    expect(registeredSettingsFeatures()).toEqual(expect.arrayContaining(['orgs', 'telemetry']));
  });
});

/** The binary POST the telemetry explorer's export goes through. */
describe('appPostBlob', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    api.setAccessToken('tok-1');
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    api.setAccessToken(null);
  });

  it('is the transport the platform pages call', () => {
    expect(appPlatformApi.postBlob).toBe(appPostBlob);
  });

  it('POSTs the JSON body with the bearer token and returns the body with its headers', async () => {
    fetchMock.mockResolvedValue(
      new Response('a,b\n1,2\n', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="q.csv"' } }),
    );

    const result = await appPostBlob('/admin/telemetry/export', { sql: 'SELECT 1', format: 'csv' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/admin\/telemetry\/export$/);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ sql: 'SELECT 1', format: 'csv' });
    expect(await result.blob.text()).toBe('a,b\n1,2\n');
    expect(result.headers.get('content-disposition')).toContain('q.csv');
  });

  it('refreshes once on a 401 and retries', async () => {
    vi.spyOn(api, 'refreshToken').mockImplementation(async () => {
      api.setAccessToken('tok-2');
      return true;
    });
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await appPostBlob('/admin/telemetry/export', {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer tok-2');
  });

  it('throws the API error message on a failure', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Only read-only statements are allowed', code: 'BAD_REQUEST' }), { status: 400 }),
    );

    await expect(appPostBlob('/admin/telemetry/export', {})).rejects.toThrow('Only read-only statements are allowed');
  });
});
