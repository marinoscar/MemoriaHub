/**
 * Unit tests for PersonGrid component.
 *
 * PersonCardContainer calls getMedia internally to resolve the cover image URL
 * (preferring downloadUrl over thumbnailUrl for full-res face crops).
 * Mock services/media to avoid real API calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PersonGrid } from '../../../components/people/PersonGrid';
import type { PersonListItem } from '../../../services/face';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../services/media', () => ({
  listMedia: vi.fn().mockResolvedValue({ items: [], meta: {} }),
  getMedia: vi.fn().mockResolvedValue({
    id: 'media-1',
    thumbnailUrl: 'https://example.com/thumb.jpg',
    downloadUrl: 'https://example.com/full.jpg',
  }),
}));

vi.mock('../../../services/face', () => ({
  listPeople: vi.fn(),
  getPerson: vi.fn(),
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  assignFaces: vi.fn(),
  unassignFace: vi.fn(),
  clusterUnknownFaces: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePerson(id: string, name: string | null = 'Alice'): PersonListItem {
  return {
    id,
    name,
    isUnlabeled: name === null,
    faceCount: 2,
    coverFace: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PersonGrid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows CircularProgress when loading=true', () => {
    render(
      <PersonGrid people={[]} onPersonClick={vi.fn()} loading={true} />,
    );

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('shows default empty state message when people is empty and not loading', () => {
    render(
      <PersonGrid people={[]} onPersonClick={vi.fn()} loading={false} />,
    );

    expect(screen.getByText('No people found')).toBeInTheDocument();
  });

  it('shows custom emptyMessage when provided', () => {
    render(
      <PersonGrid
        people={[]}
        onPersonClick={vi.fn()}
        loading={false}
        emptyMessage="No clusters yet"
      />,
    );

    expect(screen.getByText('No clusters yet')).toBeInTheDocument();
  });

  it('renders a card for each person in the list', () => {
    const people = [
      makePerson('person-1', 'Alice'),
      makePerson('person-2', 'Bob'),
      makePerson('person-3', 'Carol'),
    ];

    render(
      <PersonGrid people={people} onPersonClick={vi.fn()} loading={false} />,
    );

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Carol')).toBeInTheDocument();
  });

  it('does not show loading spinner when loading=false', () => {
    render(
      <PersonGrid people={[makePerson('p1')]} onPersonClick={vi.fn()} loading={false} />,
    );

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('does not show empty message when people list is non-empty', () => {
    render(
      <PersonGrid people={[makePerson('p1')]} onPersonClick={vi.fn()} loading={false} />,
    );

    expect(screen.queryByText('No people found')).not.toBeInTheDocument();
  });
});
