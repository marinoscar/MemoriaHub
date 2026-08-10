/**
 * Route regression tests for issue #367 — the v0 server-side backup page was
 * deleted and both of its paths now redirect to the Worker Nodes page, where
 * epic #308's replacement (per-node Local Media Backup) is reached.
 *
 * `/admin/settings/backup` was a bookmarkable admin page, so it redirects
 * rather than 404s. `/admin/backup` previously redirected to
 * `/admin/settings/backup`; it is repointed directly at the new destination so
 * there is no two-hop chain.
 *
 * The assertion is on the router's resolved location rather than on rendered
 * page content: a `<LocationProbe />` sibling inside the same MemoryRouter sees
 * whatever location App's `<Navigate>` settles on, which is exactly the
 * "lands on X in a single redirect" property, independent of what the
 * destination page renders or which API calls it makes.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import App from '../../App';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

async function resolvePath(from: string): Promise<string> {
  render(
    <MemoryRouter initialEntries={[from]}>
      <App />
      <LocationProbe />
    </MemoryRouter>,
  );

  await waitFor(
    () => {
      expect(screen.getByTestId('location')).not.toHaveTextContent(from);
    },
    { timeout: 5000 },
  );

  return screen.getByTestId('location').textContent ?? '';
}

describe('v0 backup route retirement (#367)', () => {
  it('/admin/settings/backup lands on /admin/settings/nodes', async () => {
    expect(await resolvePath('/admin/settings/backup')).toBe('/admin/settings/nodes');
  });

  it('/admin/backup lands on /admin/settings/nodes in a single hop', async () => {
    // Not /admin/settings/backup — the old two-hop chain is gone.
    expect(await resolvePath('/admin/backup')).toBe('/admin/settings/nodes');
  });
});
