/**
 * Unit tests for PersonCard component.
 *
 * PersonCard now renders PersonAvatar internally (no imageUrl prop). We mock
 * PersonAvatar to avoid async media fetching complexity in these unit tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PersonCard } from '../../../components/people/PersonCard';
import type { PersonListItem } from '../../../services/face';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Stub out PersonAvatar so PersonCard tests don't depend on async media fetching
vi.mock('../../../components/people/PersonAvatar', () => ({
  PersonAvatar: () => <div data-testid="person-avatar" />,
}));

// PersonCard doesn't call getMedia directly any more, but mock it just in case
// a transitive import resolves it.
vi.mock('../../../services/media', () => ({
  getMedia: vi.fn().mockResolvedValue({
    id: 'media-1',
    thumbnailUrl: 'https://example.com/thumb.jpg',
    downloadUrl: 'https://example.com/full.jpg',
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePerson(overrides: Partial<PersonListItem> = {}): PersonListItem {
  return {
    id: 'person-1',
    name: 'Alice',
    isUnlabeled: false,
    faceCount: 3,
    coverFace: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    profileMediaItemId: null,
    profileCrop: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PersonCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the person name', () => {
    render(<PersonCard person={makePerson()} onClick={vi.fn()} />);

    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('renders "Unlabeled" when name is null', () => {
    render(<PersonCard person={makePerson({ name: null })} onClick={vi.fn()} />);

    expect(screen.getByText('Unlabeled')).toBeInTheDocument();
  });

  it('shows "Unlabeled" chip when isUnlabeled is true', () => {
    render(
      <PersonCard
        person={makePerson({ name: null, isUnlabeled: true })}
        onClick={vi.fn()}
      />,
    );

    const chips = screen.getAllByText('Unlabeled');
    expect(chips.length).toBeGreaterThanOrEqual(1);
  });

  it('does not show "Unlabeled" chip when isUnlabeled is false', () => {
    render(
      <PersonCard
        person={makePerson({ name: 'Alice', isUnlabeled: false })}
        onClick={vi.fn()}
      />,
    );

    expect(screen.queryByText('Unlabeled')).not.toBeInTheDocument();
  });

  it('shows face count chip with "3 photos"', () => {
    render(<PersonCard person={makePerson({ faceCount: 3 })} onClick={vi.fn()} />);

    expect(screen.getByText('3 photos')).toBeInTheDocument();
  });

  it('shows "1 photo" (singular) when faceCount is 1', () => {
    render(<PersonCard person={makePerson({ faceCount: 1 })} onClick={vi.fn()} />);

    expect(screen.getByText('1 photo')).toBeInTheDocument();
  });

  it('renders PersonAvatar (data-testid="person-avatar")', () => {
    render(<PersonCard person={makePerson()} onClick={vi.fn()} />);

    expect(screen.getByTestId('person-avatar')).toBeInTheDocument();
  });

  it('renders PersonAvatar even when coverFace is null', () => {
    render(
      <PersonCard
        person={makePerson({ coverFace: null })}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByTestId('person-avatar')).toBeInTheDocument();
  });

  it('renders PersonAvatar when coverFace is set', () => {
    render(
      <PersonCard
        person={makePerson({
          coverFace: {
            faceId: 'face-1',
            mediaItemId: 'media-1',
            boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          },
        })}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByTestId('person-avatar')).toBeInTheDocument();
  });

  it('calls onClick when card is clicked', () => {
    const person = makePerson();
    const handleClick = vi.fn();

    render(<PersonCard person={person} onClick={handleClick} />);

    fireEvent.click(screen.getByText('Alice'));

    expect(handleClick).toHaveBeenCalledWith(person);
  });
});
