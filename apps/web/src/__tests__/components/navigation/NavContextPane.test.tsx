/**
 * The two context-pane CONTENTS the app binds to the shell's
 * `ShellDestination.contextPane` (RETRO-F1, #571; the panes are issue #392).
 * The column around them (width, sticky geometry, `<aside>` landmark, when it
 * shows) is the packaged rail's and is covered in `NavigationRail.test.tsx`;
 * this file pins that each pane mounts the hub's own list and resolves the
 * active entry from the URL.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import {
  CollectionsContextPane,
  ReviewContextPane,
} from '../../../components/navigation/NavContextPane';

vi.mock('../../../components/collections/CollectionsList', () => ({
  CollectionsList: ({ activeKey, variant }: { activeKey: string | null; variant: string }) => (
    <div data-testid="collections-list" data-variant={variant}>
      {String(activeKey)}
    </div>
  ),
}));
vi.mock('@marinoscar/memoriahub-web/hubs/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ReviewQueueList: ({ activeKey, variant }: { activeKey: string | null; variant: string }) => (
    <div data-testid="review-list" data-variant={variant}>
      {String(activeKey)}
    </div>
  ),
}));

describe('ReviewContextPane', () => {
  it.each([
    ['/bursts', 'bursts'],
    ['/bursts/some-id', 'bursts'],
    ['/review/duplicates', 'duplicates'],
    ['/review', 'null'],
  ])('at %s marks %s active', (pathname, key) => {
    render(<ReviewContextPane activeDestination="review" pathname={pathname} />);
    expect(screen.getByRole('heading', { name: 'Review' })).toBeInTheDocument();
    const list = screen.getByTestId('review-list');
    expect(list).toHaveAttribute('data-variant', 'pane');
    expect(list).toHaveTextContent(key);
  });
});

describe('CollectionsContextPane', () => {
  it.each([
    ['/albums', 'albums'],
    ['/people/p1', 'people'],
    ['/collections', 'null'],
  ])('at %s marks %s active', (pathname, key) => {
    render(<CollectionsContextPane activeDestination="collections" pathname={pathname} />);
    expect(screen.getByRole('heading', { name: 'Collections' })).toBeInTheDocument();
    expect(screen.getByTestId('collections-list')).toHaveTextContent(key);
  });
});
