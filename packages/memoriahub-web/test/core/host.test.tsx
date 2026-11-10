import { render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  MemoriahubApiError,
  MemoriahubHostMissingError,
  MemoriahubWebHostProvider,
  api,
  getActiveMemoriahubHost,
  setActiveMemoriahubHost,
  useFeatureFlags,
  useMemoriahubHost,
  useOwnerScope,
  usePermissions,
} from '../../src/core/headless/index.js';
import { defineHostSlot } from '../../src/core/ui/index.js';
import { createFakeMemoriahubWebHost, fakeApiError, renderWithMemoriahubHost } from '../../src/core/testing/index.js';

describe('MemoriahubWebHost', () => {
  it('refuses to render without a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useMemoriahubHost())).toThrow(MemoriahubHostMissingError);
    spy.mockRestore();
  });

  it('refuses a headless call with no active host', () => {
    setActiveMemoriahubHost(null);
    expect(() => getActiveMemoriahubHost()).toThrow(MemoriahubHostMissingError);
  });

  it('sends the headless client through the provided host', async () => {
    const { host, calls } = createFakeMemoriahubWebHost({ routes: { 'GET /media/:id': { id: 'm1' } } });
    render(<MemoriahubWebHostProvider host={host}>x</MemoriahubWebHostProvider>);
    await expect(api.get('/media/m1?a=1')).resolves.toEqual({ id: 'm1' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/media/m1', endpoint: '/media/m1?a=1' });
    expect(calls[0].query.get('a')).toBe('1');
  });

  it('rejects a route that throws with the error the slice tests for', async () => {
    const { host } = createFakeMemoriahubWebHost({
      routes: {
        'DELETE /media/:id': () => {
          throw fakeApiError(409, 'Conflict', 'CONFLICT');
        },
      },
    });
    setActiveMemoriahubHost(host);
    await expect(api.delete('/media/m1')).rejects.toBeInstanceOf(MemoriahubApiError);
  });

  it('derives the permission helpers from the principal', () => {
    const { host } = createFakeMemoriahubWebHost({ principal: { permissions: ['media:read'], roles: ['admin'] } });
    const { result } = renderHook(() => usePermissions(), {
      wrapper: ({ children }) => <MemoriahubWebHostProvider host={host}>{children}</MemoriahubWebHostProvider>,
    });
    expect(result.current.hasPermission('media:read')).toBe(true);
    expect(result.current.hasPermission('media:write')).toBe(false);
    expect(result.current.hasAnyPermission('x', 'media:read')).toBe(true);
    expect(result.current.isAdmin).toBe(true);
  });

  it('reads the owner scope and the feature flags from the host', () => {
    const { host } = createFakeMemoriahubWebHost({ features: { flags: { memories: true } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <MemoriahubWebHostProvider host={host}>{children}</MemoriahubWebHostProvider>
    );
    expect(renderHook(() => useOwnerScope(), { wrapper }).result.current.activeCircleId).toBe('lib-1');
    expect(renderHook(() => useFeatureFlags(), { wrapper }).result.current.flags).toEqual({ memories: true });
  });
});

describe('defineHostSlot', () => {
  const Bridge = defineHostSlot<{ label: string }>('test.slot');

  it('renders the component the host registers', () => {
    const { host } = createFakeMemoriahubWebHost({ slots: { 'test.slot': ({ label }: { label: string }) => <p>{label}</p> } });
    renderWithMemoriahubHost(<Bridge label="from the host" />, host);
    expect(screen.getByText('from the host')).toBeInTheDocument();
  });

  it('renders nothing when the host registers none', () => {
    const { host } = createFakeMemoriahubWebHost();
    const { container } = renderWithMemoriahubHost(<Bridge label="x" />, host);
    expect(container).toBeEmptyDOMElement();
  });
});
