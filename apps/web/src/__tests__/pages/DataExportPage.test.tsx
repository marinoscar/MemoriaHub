/**
 * "Download your data" as MemoriaHub binds it (RETRO-H2, #596).
 *
 * The page is the platform's (`@marinoscar/platform-web/exports/ui`) and is tested in the package.
 * What is this app's, and tested here: the page reads the sources the API offers through the host
 * transport (MemoriaHub's four next to the platform's `user-data`), the user card sits in its own
 * group before the pinned-last Danger Zone with no permission, and the admin card carries the
 * permission the exports service checks for `org-data`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import type { PlatformApiClient, PlatformWebHost } from '@marinoscar/platform-web/core';
import { DataExportPage, dataExportSettingsPage } from '@marinoscar/platform-web/exports/ui';

import { ADMIN_SECTIONS } from '../../config/adminSections';
import { USER_SETTINGS_SECTIONS } from '../../config/userSettingsSections';

const FORMATS = [
  { id: 'json', label: 'JSON', extension: 'json', mimeType: 'application/json' },
  { id: 'csv', label: 'CSV', extension: 'zip', mimeType: 'application/zip' },
  { id: 'xlsx', label: 'Excel', extension: 'xlsx', mimeType: 'application/vnd.ms-excel' },
];

const SOURCES = {
  items: [
    { id: 'user-data', scope: 'user', label: 'Your data', formats: FORMATS, fields: [], crossOrg: false },
    {
      id: 'memoriahub-media',
      scope: 'user',
      label: 'Your photos and videos (details)',
      formats: FORMATS,
      fields: [],
      crossOrg: false,
    },
  ],
};

function renderPage() {
  const get = vi.fn(async (path: string) => (path.includes('/exports/sources') ? SOURCES : { items: [] }));
  const api = { get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } as unknown as PlatformApiClient;
  const host: PlatformWebHost = {
    api,
    viewer: {
      userId: 'u1',
      email: 'person-a@example.test',
      hasPermission: () => true,
      isFeatureEnabled: () => false,
      refresh: async () => undefined,
    },
  };
  render(
    <MemoryRouter>
      <PlatformHostProvider host={host}>
        <DataExportPage />
      </PlatformHostProvider>
    </MemoryRouter>,
  );
  return { get };
}

describe('DataExportPage (packaged)', () => {
  it('reads the sources and the recent exports through the host transport', async () => {
    const { get } = renderPage();
    await waitFor(() => expect(get.mock.calls.some(([path]) => String(path).includes('/exports/sources'))).toBe(true));
    expect(get.mock.calls.some(([path]) => /\/exports$/.test(String(path).split('?')[0]!))).toBe(true);
    expect(await screen.findByRole('heading', { name: 'Download your data' })).toBeInTheDocument();
  });
});

describe('data export registry cards', () => {
  it('puts the packaged card in a "Your data" group, ungated, right before the Danger Zone', () => {
    const labels = USER_SETTINGS_SECTIONS.map((section) => section.label);
    const index = labels.indexOf('Your data');
    expect(index).toBe(labels.length - 2);
    const [card] = USER_SETTINGS_SECTIONS[index]!.cards;
    expect(card!.path).toBe(dataExportSettingsPage.card.path);
    expect(card!.permission).toBeUndefined();
  });

  it('gates the admin organization export card on org_members:read', () => {
    const cards = ADMIN_SECTIONS.flatMap((section) => section.cards).filter(
      (card) => card.path === '/admin/settings/data-export',
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]!.permission).toBe('org_members:read');
  });
});
