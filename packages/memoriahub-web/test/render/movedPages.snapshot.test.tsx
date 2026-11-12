/**
 * Render snapshots of the moved pages, through the fake host (RETRO-J11, #626).
 *
 * The pages left `apps/web/src` for this package; what proves they still draw what they drew is the tree they
 * render from a host that answers fixed data. Each case renders one page through `renderWithProviders` with the
 * fake host's HTTP router and compares the normalized DOM with the committed snapshot
 * (`__snapshots__/movedPages.snapshot.test.tsx.snap`). A change to the markup is a diff in review: update the
 * snapshot on purpose (`vitest -u`), never to make a failure go away.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { render, mockAdminUser, flushPendingAsyncWork } from '../utils/test-utils.js';
import { normalizedHtml } from '../utils/domSnapshot.js';

import { MemoriesPage } from '../../src/memories/ui/pages/MemoriesPage.js';
import ReviewHubPage from '../../src/hubs/ui/pages/ReviewHubPage.js';
import { WorkflowListPage } from '../../src/workflows/ui/index.js';
import { MediaSyncPage } from '../../src/media-sync/ui/index.js';
import { SearchPanel } from '../../src/search/ui/components/SearchPanel.js';
import { __resetReviewCountsForTests } from '../../src/hubs/headless/hooks/useReviewCounts.js';

const androidPort = {
  appName: 'Product X',
  legacyPackageName: 'example.legacy',
  mediaSyncDeepLink: (path?: string) => `example://media-sync${path ? `/${path}` : ''}`,
  isRunningInTwa: () => false,
  getInstalledAppVersion: () => null,
  useAndroidRelease: () => ({ release: null, isLoading: false, error: null }),
  useAndroidDownloadLink: () => ({ downloadLink: async () => ({ url: '/dl', expiresAt: '2030-01-01T00:00:00Z' }) }),
};

const admin = { ...mockAdminUser, permissions: [...mockAdminUser.permissions, 'media:read', 'media:write', 'media:delete'] };

describe('moved pages render through the fake host', () => {
  beforeEach(() => {
    __resetReviewCountsForTests();
  });
  afterEach(async () => {
    await flushPendingAsyncWork();
  });

  it('MemoriesPage', async () => {
    const { container } = render(<MemoriesPage />, {
      wrapperOptions: {
        user: admin,
        route: '/memories',
        features: { flags: { memories: true } },
        routes: {
          'GET /memories': {
            items: [
              {
                id: 'mem-1',
                type: 'trip',
                title: 'Trip to the coast',
                subtitle: 'March 2023',
                itemCount: 24,
                periodStart: '2023-03-12T00:00:00.000Z',
                periodEnd: '2023-03-18T00:00:00.000Z',
                coverMediaItemId: null,
                coverThumbnailUrl: null,
                meta: null,
                myState: { seen: false, favorited: false },
                generatedAt: '2026-08-01T00:00:00.000Z',
              },
            ],
            meta: { pageSize: 24, nextCursor: null, hasMore: false },
          },
        },
      },
    });
    await screen.findByText('Trip to the coast');
    expect(normalizedHtml(container)).toMatchSnapshot();
  });

  it('ReviewHubPage', async () => {
    const { container } = render(<ReviewHubPage />, {
      wrapperOptions: {
        user: admin,
        route: '/review',
        features: { flags: { burstDetection: true, duplicateDetection: true, locationInference: true } },
        shell: { useMainVariant: () => undefined, useContextPaneVisible: () => false },
        routes: {
          'GET /media/review-counts': {
            pendingBurstGroups: 2,
            pendingDuplicateGroups: 5,
            pendingLocationSuggestions: 0,
            pendingEnhancements: 0,
          },
        },
      },
    });
    await screen.findByText(/burst/i);
    await waitFor(() => expect(container.textContent).toMatch(/5/));
    expect(normalizedHtml(container)).toMatchSnapshot();
  });

  it('WorkflowListPage', async () => {
    const { container } = render(<WorkflowListPage />, {
      wrapperOptions: {
        user: admin,
        route: '/review/automations',
        routes: {
          'GET /workflows': {
            items: [
              {
                id: 'wf-1',
                circleId: 'circle-1',
                name: 'Archive screenshots',
                description: 'Moves screenshots out of the gallery',
                subjectType: 'media_item',
                enabled: true,
                trigger: 'manual',
                cronExpression: null,
                nextRunAt: null,
                definition: { version: 1, subject: 'media_item', conditions: { op: 'and', children: [] }, actions: [] },
                createdById: 'admin-user-id',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                dependencies: [],
              },
            ],
            meta: { total: 1, page: 1, pageSize: 20 },
          },
        },
      },
    });
    await screen.findByText('Archive screenshots');
    expect(normalizedHtml(container)).toMatchSnapshot();
  });

  it('MediaSyncPage with no phone paired', async () => {
    const { container } = render(
      <Routes>
        <Route path="/settings/media-sync" element={<MediaSyncPage />} />
      </Routes>,
      {
        wrapperOptions: { user: admin, route: '/settings/media-sync', android: androidPort as never, routes: { 'GET /media-sync/devices': [] } },
      },
    );
    await screen.findByTestId('get-android-app');
    expect(normalizedHtml(container)).toMatchSnapshot();
  });

  it('SearchPanel', async () => {
    render(<SearchPanel open onClose={vi.fn()} onSubmit={vi.fn()} circleId="circle-1" />, {
      wrapperOptions: {
        user: admin,
        routes: { 'GET /media/facets/locations': [], 'GET /media/explore/tags': [], 'GET /search/fields': [] },
      },
    });
    await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument());
    // The panel is a dialog: it renders into the document body, not the render container.
    expect(normalizedHtml(document.body)).toMatchSnapshot();
  });
});
