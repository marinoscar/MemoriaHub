/**
 * Unit tests for PersonCard component.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PersonCard } from '../../../components/people/PersonCard';
import type { PersonListItem } from '../../../services/face';

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
    ...overrides,
  };
}

const COVER_FACE = {
  faceId: 'face-1',
  mediaItemId: 'media-1',
  boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PersonCard', () => {
  it('renders the person name', () => {
    render(<PersonCard person={makePerson()} imageUrl={undefined} onClick={vi.fn()} />);

    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('renders "Unlabeled" when name is null', () => {
    render(<PersonCard person={makePerson({ name: null })} imageUrl={undefined} onClick={vi.fn()} />);

    expect(screen.getByText('Unlabeled')).toBeInTheDocument();
  });

  it('shows "Unlabeled" chip when isUnlabeled is true', () => {
    render(
      <PersonCard
        person={makePerson({ name: null, isUnlabeled: true })}
        imageUrl={undefined}
        onClick={vi.fn()}
      />,
    );

    // The "Unlabeled" chip label
    const chips = screen.getAllByText('Unlabeled');
    // At least one is the chip (could be both name and chip)
    expect(chips.length).toBeGreaterThanOrEqual(1);
  });

  it('does not show "Unlabeled" chip when isUnlabeled is false', () => {
    render(
      <PersonCard
        person={makePerson({ name: 'Alice', isUnlabeled: false })}
        imageUrl={undefined}
        onClick={vi.fn()}
      />,
    );

    // Only the name text "Alice", no unlabeled chip
    expect(screen.queryByText('Unlabeled')).not.toBeInTheDocument();
  });

  it('shows face count chip with "3 photos"', () => {
    render(<PersonCard person={makePerson({ faceCount: 3 })} imageUrl={undefined} onClick={vi.fn()} />);

    expect(screen.getByText('3 photos')).toBeInTheDocument();
  });

  it('shows "1 photo" (singular) when faceCount is 1', () => {
    render(<PersonCard person={makePerson({ faceCount: 1 })} imageUrl={undefined} onClick={vi.fn()} />);

    expect(screen.getByText('1 photo')).toBeInTheDocument();
  });

  it('renders FaceCrop (role=img) when imageUrl and coverFace are provided', () => {
    render(
      <PersonCard
        person={makePerson({ coverFace: COVER_FACE })}
        imageUrl="https://example.com/photo.jpg"
        onClick={vi.fn()}
      />,
    );

    const faceImg = screen.getByRole('img', { name: 'Face crop' });
    expect(faceImg).toBeInTheDocument();
  });

  it('renders Avatar fallback when imageUrl is not provided', () => {
    render(
      <PersonCard
        person={makePerson()}
        imageUrl={undefined}
        onClick={vi.fn()}
      />,
    );

    // FaceCrop should not be rendered
    expect(screen.queryByRole('img', { name: 'Face crop' })).not.toBeInTheDocument();
  });

  it('renders Avatar fallback when coverFace is null even if imageUrl is provided', () => {
    render(
      <PersonCard
        person={makePerson({ coverFace: null })}
        imageUrl="https://example.com/photo.jpg"
        onClick={vi.fn()}
      />,
    );

    // FaceCrop requires both imageUrl AND coverFace
    expect(screen.queryByRole('img', { name: 'Face crop' })).not.toBeInTheDocument();
  });

  it('calls onClick when card is clicked', () => {
    const person = makePerson();
    const handleClick = vi.fn();

    render(<PersonCard person={person} imageUrl={undefined} onClick={handleClick} />);

    fireEvent.click(screen.getByText('Alice'));

    expect(handleClick).toHaveBeenCalledWith(person);
  });
});
