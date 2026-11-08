/**
 * The packaged Doctor page as MemoriaHub binds it (RETRO-B1b, #602).
 *
 * The page itself is the platform's and is tested in the package. What is this
 * app's, and tested here: the binding renders the report of
 * `GET /admin/doctor` through the host transport, groups it under this app's
 * category labels in this app's order, shows a problem's remedy, and the card
 * and route use the permission the API enforces.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import type { PlatformApiClient, PlatformWebHost } from '@marinoscar/platform-web/core';
import { doctorSettingsPage } from '@marinoscar/platform-web/doctor/ui';

import DoctorPage from '../../pages/Admin/DoctorPage';
import { DOCTOR_CATEGORIES } from '../../config/doctorCategories';
import { ADMIN_SECTIONS } from '../../config/adminSections';

function check(over: Record<string, unknown>) {
  return {
    settingsPath: null,
    remedy: null,
    error: null,
    data: null,
    durationMs: 3,
    ...over,
  };
}

const REPORT = {
  verdict: 'warn',
  generatedAt: '2026-11-08T10:00:00.000Z',
  durationMs: 40,
  checks: [
    check({ id: 'db.connection', category: 'core', label: 'Database connection', status: 'pass', detail: 'Connected in 3 ms' }),
    check({
      id: 'memoriahub.face.pgvector',
      category: 'face',
      label: 'Face pgvector index',
      status: 'warn',
      detail: 'faces_embedding_vec_archive_hnsw_idx (partial archive index) is missing',
      remedy: 'Run migrations (npx prisma migrate deploy) to add the partial archive index.',
    }),
    check({
      id: 'memoriahub.android.media-sync',
      category: 'android',
      label: 'Media sync devices',
      status: 'skip',
      detail: 'No active Media Sync device is paired.',
    }),
  ],
};

function renderPage() {
  const get = vi.fn().mockResolvedValue(REPORT);
  const api = { get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } as unknown as PlatformApiClient;
  const host: PlatformWebHost = {
    api,
    viewer: {
      userId: 'u1',
      email: 'admin@example.test',
      hasPermission: () => true,
      isFeatureEnabled: () => false,
      refresh: async () => undefined,
    },
  };
  render(
    <MemoryRouter>
      <PlatformHostProvider host={host}>
        <DoctorPage />
      </PlatformHostProvider>
    </MemoryRouter>,
  );
  return { get };
}

describe('DoctorPage (packaged binding)', () => {
  it('reads the report from GET /admin/doctor and shows this app\'s category labels', async () => {
    const { get } = renderPage();

    await waitFor(() => expect(screen.getByText('Face pgvector index')).toBeInTheDocument());
    expect(get.mock.calls[0][0]).toContain('/admin/doctor');
    expect(screen.getByText('Face recognition')).toBeInTheDocument();
    expect(screen.getByText('Android app')).toBeInTheDocument();
    expect(screen.getByText('Core')).toBeInTheDocument();
  });

  it('shows the remedy of a problem check', async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/to add the partial archive index/)).toBeInTheDocument(),
    );
  });
});

describe('Doctor registry card and categories', () => {
  it('is one admin card at the same URL, gated on the permission the API enforces', () => {
    const cards = ADMIN_SECTIONS.flatMap((section) => section.cards).filter(
      (card) => card.path === '/admin/settings/doctor',
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].permission).toBe('system_settings:read');
    expect(cards[0].permission).toBe(doctorSettingsPage.card.permission);
  });

  it('lists this app\'s categories in the order the API reports them', () => {
    expect(DOCTOR_CATEGORIES.map((c) => c.key)).toEqual([
      'core', 'auth', 'maintenance', 'storage', 'email', 'push', 'ai', 'face', 'geo',
      'jobs', 'nodes', 'workflows', 'android', 'backup', 'telemetry', 'network',
    ]);
    expect(DOCTOR_CATEGORIES.find((c) => c.key === 'face')?.label).toBe('Face recognition');
  });
});
