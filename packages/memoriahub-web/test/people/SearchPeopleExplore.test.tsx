/**
 * SearchPeopleExplore: the people carousel of the search page's explore view (the host's
 * `search.peopleExplore` slot of the packaged search page). People belong to the people
 * slice, which has not moved into `@marinoscar/memoriahub-web` yet, so these cases live
 * with the app's component. The favourites-first sort, the unlabeled filter and the
 * "View all" link are the behaviour the packaged page had before the slot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils/test-utils.js';

vi.mock('../../src/people/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/people/headless/index.js')>()),
  usePeople: vi.fn(),
}));

import { SearchPeopleExplore } from '../../src/people/ui/components/SearchPeopleExplore.js';
import { usePeople } from '../../src/people/headless/index.js';

const mockUsePeople = vi.mocked(usePeople);

function defaultPeopleMock() {
  return {
    data: { items: [], meta: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } },
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    cluster: vi.fn(),
    assignFaces: vi.fn(),
    unassignFace: vi.fn(),
  };
}

describe('SearchPeopleExplore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePeople.mockReturnValue(defaultPeopleMock() as any);
  });

    it('shows People section when people are available', () => {
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            { id: 'p-1', name: 'Alice', isUnlabeled: false, faceCount: 3, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
        },
      } as any);

      render(<SearchPeopleExplore circleId="circle-1" />);

      expect(screen.getByText('People')).toBeInTheDocument();
    });

    it('shows "View all" button for People section when people are loaded', () => {
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            { id: 'p-1', name: 'Alice', isUnlabeled: false, faceCount: 5, coverFace: null, createdAt: '', updatedAt: '', favorite: true },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
        },
      } as any);

      render(<SearchPeopleExplore circleId="circle-1" />);

      const viewAllButtons = screen.getAllByRole('button', { name: /view all/i });
      expect(viewAllButtons.length).toBeGreaterThan(0);
    });

  describe('People sort order', () => {
    it('renders the favorite person before a non-favorite when count allows 1 tile', () => {
      // jsdom: getBoundingClientRect returns 0 → useFittedCount clamps to 1.
      // The person that appears must be the one that sorts first: favorite first.
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            // Carol is non-favorite with many faces — should sort AFTER Dave
            { id: 'p-carol', name: 'Carol', isUnlabeled: false, faceCount: 50, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
            // Dave is a favorite with fewer faces — sorts FIRST
            { id: 'p-dave', name: 'Dave', isUnlabeled: false, faceCount: 3, coverFace: null, createdAt: '', updatedAt: '', favorite: true },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
        },
      } as any);

      render(<SearchPeopleExplore circleId="circle-1" />);

      // Dave (favorite=true) must appear since it's the first item after sort
      expect(screen.getByText('Dave')).toBeInTheDocument();
      // Carol should not appear because jsdom caps the carousel at 1 tile
      expect(screen.queryByText('Carol')).not.toBeInTheDocument();
    });

    it('renders the person with the highest faceCount first when no favorites', () => {
      // Non-favorite items are sorted by faceCount desc; 1 tile visible in jsdom.
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            // Eve has fewer faces — sorts second
            { id: 'p-eve', name: 'Eve', isUnlabeled: false, faceCount: 2, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
            // Frank has more faces — sorts first
            { id: 'p-frank', name: 'Frank', isUnlabeled: false, faceCount: 10, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
        },
      } as any);

      render(<SearchPeopleExplore circleId="circle-1" />);

      // Frank (higher faceCount) must be visible
      expect(screen.getByText('Frank')).toBeInTheDocument();
      // Eve should not appear because jsdom caps the carousel at 1 tile
      expect(screen.queryByText('Eve')).not.toBeInTheDocument();
    });

    it('excludes unlabeled (null-name) people from the People row', () => {
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            { id: 'p-unlabeled', name: null, isUnlabeled: true, faceCount: 8, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
            { id: 'p-named', name: 'Grace', isUnlabeled: false, faceCount: 1, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
        },
      } as any);

      render(<SearchPeopleExplore circleId="circle-1" />);

      // Grace should be visible; the unnamed person has no text to check
      expect(screen.getByText('Grace')).toBeInTheDocument();
    });
  });

  describe('People explore row', () => {
    it('shows the People section header and at least one person when people are available', () => {
      // Note: useFittedCount seeds from getBoundingClientRect().width which
      // returns 0 in jsdom, clamping count to 1. We therefore assert the
      // section header and the first visible person (Alice), not every item.
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            { id: 'p-1', name: 'Alice', isUnlabeled: false, faceCount: 3, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
            { id: 'p-2', name: 'Bob', isUnlabeled: false, faceCount: 2, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
        },
      } as any);

      render(<SearchPeopleExplore circleId="circle-1" />);

      // Section header must always be visible
      expect(screen.getByText('People')).toBeInTheDocument();
      // At least the first person tile renders
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    it('shows the "View all" button in the People section', () => {
      mockUsePeople.mockReturnValue({
        ...defaultPeopleMock(),
        data: {
          items: [
            { id: 'p-1', name: 'Alice', isUnlabeled: false, faceCount: 3, coverFace: null, createdAt: '', updatedAt: '', favorite: false },
          ],
          meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
        },
      } as any);

      render(<SearchPeopleExplore circleId="circle-1" />);

      // The People ExploreCarousel sets viewAllLabel="View all" and onViewAll=navigate('/people')
      // At least one "View all" button should be present in the explore view
      const viewAllButtons = screen.getAllByRole('button', { name: /view all/i });
      expect(viewAllButtons.length).toBeGreaterThan(0);
    });

    it('does NOT show the People section when there are no labeled people', () => {
      // defaultPeopleMock returns no items — People section should not render
      render(<SearchPeopleExplore circleId="circle-1" />);

      expect(screen.queryByText('People')).not.toBeInTheDocument();
    });
  });
});
