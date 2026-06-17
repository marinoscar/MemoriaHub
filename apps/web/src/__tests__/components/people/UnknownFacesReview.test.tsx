/**
 * Unit tests for UnknownFacesReview component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UnknownFacesReview } from '../../../components/people/UnknownFacesReview';
import type { PersonListItem, ClusterResult } from '../../../services/face';

// ---------------------------------------------------------------------------
// Mock PersonGrid's dependency on services/media
// ---------------------------------------------------------------------------

vi.mock('../../../services/media', () => ({
  listMedia: vi.fn().mockResolvedValue({ items: [], meta: {} }),
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

function makePerson(id: string): PersonListItem {
  return {
    id,
    name: null,
    isUnlabeled: true,
    faceCount: 2,
    coverFace: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const DEFAULT_PROPS = {
  unlabeledPeople: [],
  onPersonClick: vi.fn(),
  onCluster: vi.fn(),
  onRename: vi.fn(),
  canCluster: true,
  loading: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UnknownFacesReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "Unknown People" heading', () => {
    render(<UnknownFacesReview {...DEFAULT_PROPS} />);

    expect(screen.getByText('Unknown People')).toBeInTheDocument();
  });

  it('shows the count of unlabeled people as a chip', () => {
    const people = [makePerson('p1'), makePerson('p2'), makePerson('p3')];

    render(<UnknownFacesReview {...DEFAULT_PROPS} unlabeledPeople={people} />);

    // Chip showing count
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows count chip of 0 when unlabeledPeople is empty', () => {
    render(<UnknownFacesReview {...DEFAULT_PROPS} unlabeledPeople={[]} />);

    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('shows "Find People" button when canCluster=true', () => {
    render(<UnknownFacesReview {...DEFAULT_PROPS} canCluster={true} />);

    expect(screen.getByRole('button', { name: /find people/i })).toBeInTheDocument();
  });

  it('hides "Find People" button when canCluster=false', () => {
    render(<UnknownFacesReview {...DEFAULT_PROPS} canCluster={false} />);

    expect(screen.queryByRole('button', { name: /find people/i })).not.toBeInTheDocument();
  });

  it('calls onCluster when "Find People" is clicked', async () => {
    const onCluster = vi.fn().mockResolvedValue({ clustersCreated: 1, facesAssigned: 3 } as ClusterResult);
    const user = userEvent.setup();

    render(<UnknownFacesReview {...DEFAULT_PROPS} onCluster={onCluster} canCluster={true} />);

    await user.click(screen.getByRole('button', { name: /find people/i }));

    expect(onCluster).toHaveBeenCalled();
  });

  it('shows success alert with cluster result counts after Find People', async () => {
    const onCluster = vi.fn().mockResolvedValue({
      clustersCreated: 2,
      facesAssigned: 5,
    } as ClusterResult);
    const user = userEvent.setup();

    render(<UnknownFacesReview {...DEFAULT_PROPS} onCluster={onCluster} canCluster={true} />);

    await user.click(screen.getByRole('button', { name: /find people/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    // Alert contains cluster counts
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('2');
    expect(alert.textContent).toContain('5');
  });

  it('shows error alert when onCluster throws', async () => {
    const onCluster = vi.fn().mockRejectedValue(new Error('Clustering failed'));
    const user = userEvent.setup();

    render(<UnknownFacesReview {...DEFAULT_PROPS} onCluster={onCluster} canCluster={true} />);

    await user.click(screen.getByRole('button', { name: /find people/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    expect(screen.getByRole('alert').textContent).toContain('Clustering failed');
  });

  it('shows "no unknown people clusters" message when unlabeledPeople is empty', () => {
    render(<UnknownFacesReview {...DEFAULT_PROPS} unlabeledPeople={[]} />);

    expect(
      screen.getByText(/no unknown people clusters found/i),
    ).toBeInTheDocument();
  });

  it('does not show the empty message when unlabeledPeople has items', () => {
    const people = [makePerson('p1')];

    render(
      <UnknownFacesReview {...DEFAULT_PROPS} unlabeledPeople={people} />,
    );

    expect(screen.queryByText(/no unknown people clusters found/i)).not.toBeInTheDocument();
  });
});
