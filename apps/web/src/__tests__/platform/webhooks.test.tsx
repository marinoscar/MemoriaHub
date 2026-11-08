/**
 * The packaged Webhooks page as MemoriaHub routes it (RETRO-H4, #603).
 *
 * The page is the platform's and is tested in the package. What is this app's, and tested here:
 * each scope's page reads its own route family through the app's host transport (`/webhooks` for a
 * member's own endpoints, `/admin/webhooks` for the deployment's), draws its write controls only for
 * the `:write` holder, and the cards carry the permission each controller enforces.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import type { PlatformApiClient, PlatformWebHost } from '@marinoscar/platform-web/core';
import { WebhooksPage, webhooksAdminSections, webhooksUserSettingsSections } from '@marinoscar/platform-web/webhooks/ui';

import { ADMIN_SECTIONS } from '../../config/adminSections';
import { USER_SETTINGS_SECTIONS } from '../../config/userSettingsSections';

function renderPage(scope: 'user' | 'system', permissions: string[]) {
  const get = vi.fn().mockResolvedValue({ items: [] });
  const api = { get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } as unknown as PlatformApiClient;
  const host: PlatformWebHost = {
    api,
    viewer: {
      userId: 'u1',
      email: 'person-a@example.test',
      hasPermission: (permission: string) => permissions.includes(permission),
      isFeatureEnabled: () => false,
      refresh: async () => undefined,
    },
  };
  render(
    <MemoryRouter>
      <PlatformHostProvider host={host}>
        <WebhooksPage scope={scope} />
      </PlatformHostProvider>
    </MemoryRouter>,
  );
  return { get };
}

describe('WebhooksPage as routed by MemoriaHub', () => {
  it('scope user reads the caller\'s own endpoints from /webhooks', async () => {
    const { get } = renderPage('user', ['webhooks:read', 'webhooks:write']);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const paths = get.mock.calls.map(([path]) => String(path));
    expect(paths.some((path) => /(^|\/)webhooks(\?|$)/.test(path) && !path.includes('admin'))).toBe(true);
  });

  it('scope system reads the deployment\'s endpoints from /admin/webhooks', async () => {
    const { get } = renderPage('system', ['system_webhooks:read', 'system_webhooks:write']);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get.mock.calls.some(([path]) => String(path).includes('admin/webhooks'))).toBe(true);
  });

  it('is read-only without the scope\'s :write permission', async () => {
    renderPage('system', ['system_webhooks:read']);
    await waitFor(() => expect(screen.getByText(/read-only/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /new endpoint/i })).not.toBeInTheDocument();
  });
});

describe('Webhooks registry cards', () => {
  it('the per-user card is the packaged one, once, gated on webhooks:read', () => {
    const cards = USER_SETTINGS_SECTIONS.flatMap((s) => s.cards).filter((c) => c.path === '/settings/webhooks');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toBe(webhooksUserSettingsSections.integrations[0]);
    expect(cards[0].permission).toBe('webhooks:read');
  });

  it('the admin card is the packaged system one, once, gated on system_webhooks:read', () => {
    const cards = ADMIN_SECTIONS.flatMap((s) => s.cards).filter((c) => c.path === '/admin/settings/webhooks');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toBe(webhooksAdminSections.operations[0]);
    expect(cards[0].permission).toBe('system_webhooks:read');
  });
});
