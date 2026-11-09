/**
 * Public links on the sharing slice (RETRO-I4, #578), web side:
 *
 *  - an old `/s/<token>` URL is moved to `/s#lnk_<token>` (the imported grant's token),
 *    without a history entry, and a token already carrying `lnk_` is not prefixed twice;
 *  - the `media_item` and `album` renderers are registered (then frozen) and fetch their view
 *    with the token in the `x-link-token` header, never in the path or a query string;
 *  - they render the presigned URLs and nothing else, and a failed view is "not available";
 *  - the inline link panel creates a link with the chosen expiry ("Never" = null) and revokes it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PlatformApiClient } from '@marinoscar/platform-web/core';
import type { PublicLinkResolution } from '@marinoscar/platform-contract/sharing';

const linkGrants = {
  data: [] as Array<Record<string, unknown>>,
  loading: false,
  error: null,
  pending: false,
  refresh: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  copyUrl: vi.fn(),
};

vi.mock('@marinoscar/platform-web/sharing/headless', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/sharing/headless')>()),
  useLinkGrants: () => linkGrants,
}));

import { linkRenderers } from '@marinoscar/platform-web/sharing/headless';
import LegacyShareRedirect, { legacyShareTarget } from '../../pages/Public/LegacyShareRedirect';
import { registerAppLinkRenderers } from '../../platform/linkRenderers';
import { AlbumLinkRenderer } from '../../platform/linkRenderers/AlbumLinkRenderer';
import { MediaItemLinkRenderer } from '../../platform/linkRenderers/MediaItemLinkRenderer';
import { LinkSharePanel, presetExpiry } from '../../platform/sharing/LinkSharePanel';

/** An old share token (43 base64url characters): invented. */
const OLD = 'A'.repeat(21) + '_' + 'b'.repeat(21);
const TOKEN = `lnk_${OLD}`;
const resolution = { resourceType: 'media_item', resourceId: 'item-1', role: 'viewer', expiresAt: null, title: null } as unknown as PublicLinkResolution;

function apiClient(get: (path: string, options?: { headers?: Record<string, string> }) => Promise<unknown>): PlatformApiClient {
  return { get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } as unknown as PlatformApiClient;
}

describe('legacy /s/:token links', () => {
  const replace = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('location', { ...window.location, replace });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    replace.mockReset();
  });

  it('moves the old token from the path to the lnk_ fragment, replacing the history entry', async () => {
    render(
      <MemoryRouter initialEntries={[`/s/${OLD}`]}>
        <Routes>
          <Route path="/s/:token" element={<LegacyShareRedirect />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/s#lnk_${OLD}`));
  });

  it('does not prefix a token that already is a link token', () => {
    expect(legacyShareTarget(TOKEN)).toBe(`/s#${TOKEN}`);
    expect(legacyShareTarget(OLD)).toBe(`/s#${TOKEN}`);
  });
});

describe('link renderers', () => {
  it('registers media_item and album, then freezes the registry', () => {
    registerAppLinkRenderers();
    registerAppLinkRenderers(); // idempotent

    expect(linkRenderers.get('media_item')).toBe(MediaItemLinkRenderer);
    expect(linkRenderers.get('album')).toBe(AlbumLinkRenderer);
    expect(linkRenderers.isFrozen()).toBe(true);
  });

  it('opens a shared photo with the token in the x-link-token header and shows its presigned URL', async () => {
    const get = vi.fn().mockResolvedValue({
      type: 'media_item',
      expiresAt: null,
      media: { mediaType: 'photo', width: 4, height: 3, url: 'https://storage.example.test/o.jpg?sig=1', thumbnailUrl: null },
    });

    const { container } = render(<MediaItemLinkRenderer resolution={resolution} token={TOKEN} apiClient={apiClient(get)} />);

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(get).toHaveBeenCalledWith('/public/links/media', { headers: { 'x-link-token': TOKEN } });
    expect(get.mock.calls[0][0]).not.toContain(OLD);
    expect(container.querySelector('img')!.getAttribute('src')).toBe('https://storage.example.test/o.jpg?sig=1');
  });

  it('renders an album grid from thumbnails', async () => {
    const get = vi.fn().mockResolvedValue({
      type: 'album',
      expiresAt: null,
      itemCount: 2,
      items: [
        { mediaType: 'photo', width: 4, height: 3, url: 'https://storage.example.test/1.jpg', thumbnailUrl: 'https://storage.example.test/t1.jpg' },
        { mediaType: 'video', width: 16, height: 9, url: 'https://storage.example.test/2.mp4', thumbnailUrl: 'https://storage.example.test/t2.jpg' },
      ],
    });

    const { container } = render(<AlbumLinkRenderer resolution={resolution} token={TOKEN} apiClient={apiClient(get)} />);

    expect(await screen.findByText(/2 items/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/public/links/album', { headers: { 'x-link-token': TOKEN } });
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([
      'https://storage.example.test/t1.jpg',
      'https://storage.example.test/t2.jpg',
    ]);
  });

  it('shows "not available" when the view cannot be loaded (revoked, expired, trashed)', async () => {
    const get = vi.fn().mockRejectedValue(new Error('Link not found'));

    render(<MediaItemLinkRenderer resolution={resolution} token={TOKEN} apiClient={apiClient(get)} />);

    expect(await screen.findByText('This link is not available')).toBeInTheDocument();
  });
});

describe('LinkSharePanel', () => {
  beforeEach(() => {
    linkGrants.data = [];
    linkGrants.create.mockReset().mockResolvedValue({ grant: {}, url: null, token: null });
    linkGrants.revoke.mockReset().mockResolvedValue(undefined);
  });

  it('creates a never-expiring viewer link by default', async () => {
    const user = userEvent.setup();
    render(<LinkSharePanel target={{ type: 'media_item', id: 'item-1' }} />);

    await user.click(screen.getByRole('button', { name: /create link/i }));

    expect(linkGrants.create).toHaveBeenCalledWith({ role: 'viewer', expiresAt: null });
  });

  it('lists the active link with copy and revoke, and hides expired or revoked ones', async () => {
    linkGrants.data = [
      { id: 'g-1', url: `https://app.example.test/s#${TOKEN}`, expiresAt: null, revokedAt: null },
      { id: 'g-2', url: 'https://app.example.test/s#lnk_old', expiresAt: '2000-01-01T00:00:00.000Z', revokedAt: null },
    ];
    const user = userEvent.setup();
    render(<LinkSharePanel target={{ type: 'album', id: 'album-1' }} />);

    expect(screen.getByDisplayValue(`https://app.example.test/s#${TOKEN}`)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('https://app.example.test/s#lnk_old')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create link/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /revoke link/i }));
    expect(linkGrants.revoke).toHaveBeenCalledWith('g-1');
  });

  it('turns a preset into an absolute expiry', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(presetExpiry(null, now)).toBeNull();
    expect(presetExpiry(7, now)).toBe('2026-01-08T00:00:00.000Z');
  });
});
