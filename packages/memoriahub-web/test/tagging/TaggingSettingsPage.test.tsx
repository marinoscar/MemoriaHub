/**
 * Unit tests for TaggingSettingsPage, against a fake host: the principal's roles drive the admin
 * redirect, the fake admin port serves the settings document and records the patches, and the
 * backfill and the embedded vocabulary go through the fake API client.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { createFakeMemoriahubWebHost, fakeApiError, renderWithMemoriahubHost } from '../../src/core/testing/index.js';
import type { FakeRoute } from '../../src/core/testing/index.js';
import type { MemoriahubSystemSettings } from '../../src/core/headless/index.js';
import TaggingSettingsPage from '../../src/tagging/ui/pages/TaggingSettingsPage.js';

interface Options {
  autoTagging?: boolean;
  extra?: Partial<MemoriahubSystemSettings>;
  admin?: boolean;
  settings?: null;
  error?: string;
  backfill?: FakeRoute;
}

function setup({ autoTagging = false, extra = {}, admin = true, settings, error, backfill }: Options = {}) {
  const fake = createFakeMemoriahubWebHost({
    principal: { roles: admin ? ['admin'] : [], permissions: admin ? ['ai_config:read', 'ai_config:write'] : [] },
    systemSettings: settings === null ? null : { features: { autoTagging, faceRecognition: false, burstDetection: false }, ...extra },
    systemSettingsError: error,
    routes: {
      'GET /tag-labels': [],
      'POST /admin/tagging/backfill': backfill ?? { enqueued: 0, circles: 0 },
    },
  });
  const view = renderWithMemoriahubHost(<TaggingSettingsPage />, fake.host);
  return { fake, ...view };
}

const switchOf = (label: RegExp) =>
  screen.getByText(label).closest('.MuiFormControlLabel-root')?.querySelector('input[type="checkbox"]') as HTMLInputElement;

const withVideo = (video: Record<string, unknown> = {}, ai?: MemoriahubSystemSettings['ai']): Partial<MemoriahubSystemSettings> => ({
  autoTagging: {
    video: { enabled: true, maxFrames: 6, sampleIntervalSeconds: 5, transcription: { enabled: false, leadSeconds: 30 }, ...video },
  },
  ...(ai ? { ai } : {}),
});

describe('TaggingSettingsPage', () => {
  describe('access control', () => {
    it('redirects non-admin users (renders nothing from the page)', () => {
      setup({ admin: false });
      expect(screen.queryByRole('heading', { name: /ai tagging/i })).not.toBeInTheDocument();
    });
  });

  describe('page structure', () => {
    it('renders the page heading, the back link, the Global Settings section and the vocabulary', async () => {
      setup();
      expect(screen.getByRole('heading', { name: /ai tagging/i })).toBeInTheDocument();
      expect(screen.getByText(/back to settings/i)).toBeInTheDocument();
      expect(screen.getByText('Global Settings')).toBeInTheDocument();
      expect(await screen.findByRole('table', { name: 'Tag vocabulary' })).toBeInTheDocument();
    });
  });

  describe('global auto-tagging toggle', () => {
    it('renders the global auto-tagging switch', () => {
      setup();
      expect(screen.getAllByRole('switch').length).toBeGreaterThan(0);
    });

    it('switch is unchecked when autoTagging is false', () => {
      setup({ autoTagging: false });
      expect(switchOf(/enable ai auto-tagging/i).checked).toBe(false);
    });

    it('switch is checked when autoTagging is true', () => {
      setup({ autoTagging: true });
      expect(switchOf(/enable ai auto-tagging/i).checked).toBe(true);
    });

    it('patches features.autoTagging:true when the switch is toggled on', async () => {
      const { fake } = setup({ autoTagging: false });
      await userEvent.setup().click(switchOf(/enable ai auto-tagging/i));
      await waitFor(() => {
        expect(fake.admin.settingsUpdates).toContainEqual(
          expect.objectContaining({ features: expect.objectContaining({ autoTagging: true }) }),
        );
      });
    });
  });

  // The section's job is to make the COST MODEL legible rather than present five bare numbers: a
  // video costs one AI call carrying `maxFrames` images regardless of its length, and
  // transcription bills `leadSeconds` per video (epic #452, issue #457).
  describe('video AI tagging section', () => {
    it('renders the Video section with the duration-independent cost model spelled out', () => {
      setup({ autoTagging: true, extra: withVideo() });
      expect(screen.getByRole('heading', { name: 'Video' })).toBeInTheDocument();
      expect(screen.getByText(/one AI call carrying 6 still frames/i)).toBeInTheDocument();
      expect(screen.getByText(/three-hour recital and a thirty-second clip/i)).toBeInTheDocument();
    });

    it('defaults the video switch to off when no autoTagging namespace is stored', () => {
      setup({ autoTagging: true });
      expect(switchOf(/enable ai tagging for videos/i).checked).toBe(false);
    });

    it('disables the video switch until the master auto-tagging flag is on', () => {
      setup({ autoTagging: false, extra: withVideo() });
      expect(switchOf(/enable ai tagging for videos/i).disabled).toBe(true);
      expect(screen.getByText(/master switch for both photos and videos/i)).toBeInTheDocument();
    });

    it('PATCHes only the autoTagging.video keys it changes', async () => {
      const { fake } = setup({ autoTagging: true, extra: withVideo({ enabled: false }) });
      await userEvent.setup().click(switchOf(/enable ai tagging for videos/i));
      await waitFor(() => {
        expect(fake.admin.settingsUpdates).toContainEqual({ autoTagging: { video: { enabled: true } } });
      });
    });

    it('states the audio bill in seconds, not as a bare number', () => {
      setup({ autoTagging: true, extra: withVideo({ transcription: { enabled: true, leadSeconds: 45 } }) });
      expect(screen.getByText(/first 45 seconds/i)).toBeInTheDocument();
      expect(screen.getByText(/never leaves your configured AI provider/i)).toBeInTheDocument();
    });

    it('warns and links to AI settings when transcription is on with no model configured', () => {
      setup({ autoTagging: true, extra: withVideo({ transcription: { enabled: true, leadSeconds: 30 } }) });
      expect(screen.getByText(/no transcription model selected/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /admin settings/i })).toHaveAttribute('href', '/admin/settings/ai');
    });

    it('does not warn once a transcription model is configured', () => {
      setup({
        autoTagging: true,
        extra: withVideo(
          { transcription: { enabled: true, leadSeconds: 30 } },
          { features: { transcription: { provider: 'openai', model: 'gpt-4o-mini-transcribe' } } },
        ),
      });
      expect(screen.queryByText(/no transcription model selected/i)).not.toBeInTheDocument();
    });
  });

  describe('global backfill button', () => {
    it('renders the button, disabled while autoTagging is false', () => {
      setup({ autoTagging: false });
      expect(screen.getByRole('button', { name: /run global backfill/i })).toBeDisabled();
    });

    it('is enabled when autoTagging is true', () => {
      setup({ autoTagging: true });
      expect(screen.getByRole('button', { name: /run global backfill/i })).not.toBeDisabled();
    });

    it('posts the backfill (photos only by default) when the button is clicked', async () => {
      const { fake } = setup({ autoTagging: true, backfill: { enqueued: 5, circles: 2 } });
      await userEvent.setup().click(screen.getByRole('button', { name: /run global backfill/i }));
      await waitFor(() => {
        const calls = fake.calls.filter((c) => c.method === 'POST' && c.path === '/admin/tagging/backfill');
        expect(calls).toHaveLength(1);
        expect(calls[0].body).toMatchObject({ force: false, mediaTypes: ['photo'] });
      });
    });

    it('shows the enqueued count after backfill', async () => {
      setup({ autoTagging: true, backfill: { enqueued: 7, circles: 3 } });
      await userEvent.setup().click(screen.getByRole('button', { name: /run global backfill/i }));
      await waitFor(() => {
        expect(screen.getByText(/7 jobs queued across 3 circle/i)).toBeInTheDocument();
      });
    });

    it('shows an error alert when the backfill fails', async () => {
      setup({
        autoTagging: true,
        backfill: () => {
          throw fakeApiError(503, 'Service unavailable');
        },
      });
      await userEvent.setup().click(screen.getByRole('button', { name: /run global backfill/i }));
      await waitFor(() => {
        expect(screen.getByText(/service unavailable/i)).toBeInTheDocument();
      });
    });
  });

  describe('loading state', () => {
    it('shows a spinner while settings load', () => {
      setup({ settings: null });
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows an error alert when settings fail to load', () => {
      setup({ settings: null, error: 'Failed to load settings' });
      expect(screen.getByText(/failed to load settings/i)).toBeInTheDocument();
    });
  });
});
