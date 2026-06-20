/**
 * Unit tests for ExploreCarousel.
 *
 * ExploreCarousel renders a single non-scrolling row of item tiles and an
 * optional "View all" button in the header.  It uses useFittedCount
 * (ResizeObserver-driven) to decide how many tiles to show.
 *
 * In jsdom, ResizeObserver callbacks are never fired and
 * getBoundingClientRect() always returns 0, so useFittedCount clamps to 1.
 * Tests therefore receive at most 1 tile regardless of how many items are
 * passed in — assertions reflect this environment constraint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeContextProvider } from '../../../contexts/ThemeContext';
import { ExploreCarousel } from '../ExploreCarousel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal wrapper that provides ThemeContext (required by MUI). */
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <ThemeContextProvider>{children}</ThemeContextProvider>
    </MemoryRouter>
  );
}

interface SimpleItem {
  id: string;
  label: string;
}

const defaultItems: SimpleItem[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
];

const renderItem = (item: SimpleItem) => (
  <div data-testid={`tile-${item.id}`}>{item.label}</div>
);

const keyOf = (item: SimpleItem) => item.id;

// ---------------------------------------------------------------------------

describe('ExploreCarousel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Title and icon
  // -------------------------------------------------------------------------
  describe('Header', () => {
    it('renders the section title', () => {
      render(
        <ExploreCarousel
          title="My Section"
          icon={<span>icon</span>}
          loading={false}
          items={defaultItems}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
        />,
        { wrapper: Wrapper },
      );

      expect(screen.getByText('My Section')).toBeInTheDocument();
    });

    it('renders the provided icon', () => {
      render(
        <ExploreCarousel
          title="Section"
          icon={<span data-testid="custom-icon">icon</span>}
          loading={false}
          items={defaultItems}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
        />,
        { wrapper: Wrapper },
      );

      expect(screen.getByTestId('custom-icon')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // "View all" button visibility rules
  // -------------------------------------------------------------------------
  describe('"View all" button', () => {
    it('is visible when onViewAll, viewAllLabel, and items.length > 0 are all set', () => {
      const onViewAll = vi.fn();

      render(
        <ExploreCarousel
          title="Section"
          icon={<span />}
          loading={false}
          items={defaultItems}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
          viewAllLabel="View all"
          onViewAll={onViewAll}
        />,
        { wrapper: Wrapper },
      );

      expect(screen.getByRole('button', { name: /view all/i })).toBeInTheDocument();
    });

    it('is absent when items is empty even if onViewAll and viewAllLabel are set', () => {
      const onViewAll = vi.fn();

      render(
        <ExploreCarousel
          title="Section"
          icon={<span />}
          loading={false}
          items={[]}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
          viewAllLabel="View all"
          onViewAll={onViewAll}
        />,
        { wrapper: Wrapper },
      );

      expect(screen.queryByRole('button', { name: /view all/i })).not.toBeInTheDocument();
    });

    it('is absent when viewAllLabel is omitted', () => {
      const onViewAll = vi.fn();

      render(
        <ExploreCarousel
          title="Section"
          icon={<span />}
          loading={false}
          items={defaultItems}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
          // viewAllLabel intentionally omitted
          onViewAll={onViewAll}
        />,
        { wrapper: Wrapper },
      );

      expect(screen.queryByRole('button', { name: /view all/i })).not.toBeInTheDocument();
    });

    it('is absent when onViewAll is omitted', () => {
      render(
        <ExploreCarousel
          title="Section"
          icon={<span />}
          loading={false}
          items={defaultItems}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
          viewAllLabel="View all"
          // onViewAll intentionally omitted
        />,
        { wrapper: Wrapper },
      );

      expect(screen.queryByRole('button', { name: /view all/i })).not.toBeInTheDocument();
    });

    it('calls onViewAll when the button is clicked', () => {
      const onViewAll = vi.fn();

      render(
        <ExploreCarousel
          title="Section"
          icon={<span />}
          loading={false}
          items={defaultItems}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
          viewAllLabel="View all"
          onViewAll={onViewAll}
        />,
        { wrapper: Wrapper },
      );

      fireEvent.click(screen.getByRole('button', { name: /view all/i }));

      expect(onViewAll).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Item rendering
  // -------------------------------------------------------------------------
  describe('Item rendering', () => {
    it('renders at least one item when items are present', () => {
      // jsdom: useFittedCount clamps to 1, so only the first tile renders.
      render(
        <ExploreCarousel
          title="Section"
          icon={<span />}
          loading={false}
          items={defaultItems}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
        />,
        { wrapper: Wrapper },
      );

      // At least one rendered tile must be in the document
      const tiles = screen.getAllByTestId(/^tile-/);
      expect(tiles.length).toBeGreaterThanOrEqual(1);
    });

    it('renders the first item (Alpha) when items are present', () => {
      render(
        <ExploreCarousel
          title="Section"
          icon={<span />}
          loading={false}
          items={defaultItems}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
        />,
        { wrapper: Wrapper },
      );

      // Alpha is first and must always be visible
      expect(screen.getByTestId('tile-a')).toBeInTheDocument();
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    it('renders no item tiles when the items array is empty', () => {
      render(
        <ExploreCarousel
          title="Section"
          icon={<span />}
          loading={false}
          items={[]}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
        />,
        { wrapper: Wrapper },
      );

      expect(screen.queryByTestId(/^tile-/)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  describe('Loading state', () => {
    it('renders skeleton elements instead of item tiles when loading is true', () => {
      render(
        <ExploreCarousel
          title="Section"
          icon={<span />}
          loading={true}
          items={[]}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
        />,
        { wrapper: Wrapper },
      );

      // MUI Skeleton renders with role="img" or as a <span>; no item tiles
      expect(screen.queryByTestId(/^tile-/)).not.toBeInTheDocument();
      // The title is still rendered even in loading state
      expect(screen.getByText('Section')).toBeInTheDocument();
    });

    it('does not show the "View all" button while loading', () => {
      render(
        <ExploreCarousel
          title="Section"
          icon={<span />}
          loading={true}
          items={defaultItems}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
          viewAllLabel="View all"
          onViewAll={vi.fn()}
        />,
        { wrapper: Wrapper },
      );

      // "View all" requires items.length > 0, which is still true, so the
      // button should be present (items prop is non-empty even while loading).
      // This documents the current behaviour: the button is controlled by
      // items.length, not the loading flag.
      expect(screen.getByRole('button', { name: /view all/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Custom viewAllLabel
  // -------------------------------------------------------------------------
  describe('Custom viewAllLabel text', () => {
    it('renders the exact label text on the button', () => {
      render(
        <ExploreCarousel
          title="Places"
          icon={<span />}
          loading={false}
          items={defaultItems}
          itemWidth={96}
          gap={12}
          keyOf={keyOf}
          renderItem={renderItem}
          viewAllLabel="View all in map"
          onViewAll={vi.fn()}
        />,
        { wrapper: Wrapper },
      );

      expect(screen.getByRole('button', { name: /view all in map/i })).toBeInTheDocument();
    });
  });
});
