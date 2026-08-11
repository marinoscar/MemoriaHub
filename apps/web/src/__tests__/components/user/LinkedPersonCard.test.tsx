/**
 * Unit tests for LinkedPersonCard (issue #354, profile picture management).
 *
 * Covers the four empty/populated states named in the acceptance criteria:
 *   1. Face recognition disabled globally (admin vs. non-admin messaging)
 *   2. Enabled, but zero people detected yet
 *   3. Zero circle memberships (must render an empty state, never throw)
 *   4. The populated person picker
 * ...plus the unlink affordance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser, mockAdminUser } from '../../utils/test-utils';
import { LinkedPersonCard } from '../../../components/user/LinkedPersonCard';
import type { UserProfile } from '../../../services/userProfile';

vi.mock('../../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../../services/face', () => ({
  listPeople: vi.fn(),
}));

import { useFeatureFlags } from '../../../hooks/useFeatureFlags';
import { listPeople } from '../../../services/face';

const mockUseFeatureFlags = vi.mocked(useFeatureFlags);
const mockListPeople = vi.mocked(listPeople);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'user-1',
    email: 'user@example.com',
    displayName: 'Test User',
    avatarUrl: null,
    avatarSource: 'oauth',
    providerProfileImageUrl: null,
    linkedPerson: null,
    ...overrides,
  };
}

function flagsResult(overrides: Partial<ReturnType<typeof useFeatureFlags>> = {}) {
  return {
    features: { faceRecognition: false },
    pictureEnhancement: null,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  };
}

describe('LinkedPersonCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListPeople.mockResolvedValue({
      items: [],
      meta: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 },
    });
  });

  // -------------------------------------------------------------------------
  // 1. Face recognition disabled globally
  // -------------------------------------------------------------------------
  describe('face recognition disabled globally', () => {
    it('shows an admin-facing link to Admin -> Settings -> Face for an admin', () => {
      mockUseFeatureFlags.mockReturnValue(
        flagsResult({ features: { faceRecognition: false } }),
      );

      render(
        <LinkedPersonCard profile={makeProfile()} onLinkChange={vi.fn()} />,
        { wrapperOptions: { user: mockAdminUser } },
      );

      expect(
        screen.getByText(/Face recognition is turned off/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: /Admin.*Settings.*Face/i }),
      ).toBeInTheDocument();
      expect(mockListPeople).not.toHaveBeenCalled();
    });

    it('shows a non-admin "ask an administrator" message for a non-admin', () => {
      mockUseFeatureFlags.mockReturnValue(
        flagsResult({ features: { faceRecognition: false } }),
      );

      render(
        <LinkedPersonCard profile={makeProfile()} onLinkChange={vi.fn()} />,
        { wrapperOptions: { user: mockUser } },
      );

      expect(
        screen.getByText(/Face recognition is turned off/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Ask an administrator to enable it/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: /Admin.*Settings.*Face/i }),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Enabled, zero people
  // -------------------------------------------------------------------------
  describe('enabled but zero people detected', () => {
    it('shows the "no people found" empty state', async () => {
      mockUseFeatureFlags.mockReturnValue(
        flagsResult({ features: { faceRecognition: true } }),
      );
      mockListPeople.mockResolvedValue({
        items: [],
        meta: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 },
      });

      render(<LinkedPersonCard profile={makeProfile()} onLinkChange={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText(/No people found yet/i)).toBeInTheDocument();
      });
      expect(mockListPeople).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Zero circle memberships
  // -------------------------------------------------------------------------
  describe('zero circle memberships', () => {
    it('renders an empty state instead of throwing or spinning forever', () => {
      mockUseFeatureFlags.mockReturnValue(
        flagsResult({ features: { faceRecognition: true } }),
      );

      expect(() =>
        render(
          <LinkedPersonCard profile={makeProfile()} onLinkChange={vi.fn()} />,
          { wrapperOptions: { activeCircle: null } },
        ),
      ).not.toThrow();

      expect(
        screen.getByText(/not a member of any circle yet/i),
      ).toBeInTheDocument();
      // With no circles, the picker never even tries to load people.
      expect(mockListPeople).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Populated picker
  // -------------------------------------------------------------------------
  describe('populated picker', () => {
    it('renders the Autocomplete picker once people load', async () => {
      mockUseFeatureFlags.mockReturnValue(
        flagsResult({ features: { faceRecognition: true } }),
      );
      mockListPeople.mockResolvedValue({
        items: [
          {
            id: 'person-1',
            name: 'Grandma',
            isUnlabeled: false,
            faceCount: 12,
            coverFace: null,
            profileMediaItemId: null,
            profileCrop: null,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            favorite: false,
          },
        ],
        meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
      });

      render(<LinkedPersonCard profile={makeProfile()} onLinkChange={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Find a person/i)).toBeInTheDocument();
      });
      expect(
        screen.getByRole('button', { name: /Link this person/i }),
      ).toBeDisabled(); // nothing selected yet
    });

    it('selecting a person and clicking Link calls onLinkChange with the person id', async () => {
      mockUseFeatureFlags.mockReturnValue(
        flagsResult({ features: { faceRecognition: true } }),
      );
      mockListPeople.mockResolvedValue({
        items: [
          {
            id: 'person-1',
            name: 'Grandma',
            isUnlabeled: false,
            faceCount: 12,
            coverFace: null,
            profileMediaItemId: null,
            profileCrop: null,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            favorite: false,
          },
        ],
        meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
      });
      const onLinkChange = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();

      render(<LinkedPersonCard profile={makeProfile()} onLinkChange={onLinkChange} />);

      const input = await screen.findByLabelText(/Find a person/i);
      await user.click(input);
      const option = await screen.findByText('Grandma');
      await user.click(option);

      const linkButton = screen.getByRole('button', { name: /Link this person/i });
      expect(linkButton).toBeEnabled();
      await user.click(linkButton);

      await waitFor(() => {
        expect(onLinkChange).toHaveBeenCalledWith('person-1');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Regression coverage for issue #371 — GET /api/people pageSize contract
  // and pagination/error-surfacing.
  // -------------------------------------------------------------------------
  describe('pageSize and pagination (issue #371)', () => {
    it('never requests a pageSize greater than the API cap of 100', async () => {
      mockUseFeatureFlags.mockReturnValue(
        flagsResult({ features: { faceRecognition: true } }),
      );
      mockListPeople.mockResolvedValue({
        items: [],
        meta: { page: 1, pageSize: 100, totalItems: 0, totalPages: 1 },
      });

      render(<LinkedPersonCard profile={makeProfile()} onLinkChange={vi.fn()} />);

      await waitFor(() => {
        expect(mockListPeople).toHaveBeenCalled();
      });

      // The load-bearing regression assertion: the old code requested 200,
      // which the API rejects (`.max(100)` in `people.dto.ts`). Every call
      // must request a pageSize the API actually accepts.
      for (const call of mockListPeople.mock.calls) {
        const opts = call[1] as { pageSize?: number } | undefined;
        expect(opts?.pageSize).toBeDefined();
        expect(opts!.pageSize as number).toBeLessThanOrEqual(100);
      }
      expect(mockListPeople).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ page: 1, pageSize: 100 }),
      );
    });

    it('pages through multiple pages and accumulates people from every page', async () => {
      mockUseFeatureFlags.mockReturnValue(
        flagsResult({ features: { faceRecognition: true } }),
      );

      const pageOnePerson = {
        id: 'person-page-1',
        name: 'Page One Person',
        isUnlabeled: false,
        faceCount: 3,
        coverFace: null,
        profileMediaItemId: null,
        profileCrop: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        favorite: false,
      };
      const pageTwoPerson = {
        id: 'person-page-2',
        name: 'Page Two Person',
        isUnlabeled: false,
        faceCount: 1,
        coverFace: null,
        profileMediaItemId: null,
        profileCrop: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        favorite: false,
      };

      mockListPeople.mockImplementation(async (_circleId, opts) => {
        if (opts?.page === 2) {
          return {
            items: [pageTwoPerson],
            meta: { page: 2, pageSize: 100, totalItems: 2, totalPages: 2 },
          };
        }
        return {
          items: [pageOnePerson],
          meta: { page: 1, pageSize: 100, totalItems: 2, totalPages: 2 },
        };
      });

      const user = userEvent.setup();
      render(<LinkedPersonCard profile={makeProfile()} onLinkChange={vi.fn()} />);

      const input = await screen.findByLabelText(/Find a person/i);

      await waitFor(() => {
        expect(mockListPeople).toHaveBeenCalledTimes(2);
      });
      expect(mockListPeople).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        expect.objectContaining({ page: 1, pageSize: 100 }),
      );
      expect(mockListPeople).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        expect.objectContaining({ page: 2, pageSize: 100 }),
      );

      await user.click(input);
      expect(await screen.findByText('Page One Person')).toBeInTheDocument();
      expect(await screen.findByText('Page Two Person')).toBeInTheDocument();
    });

    it('surfaces the real rejection message when every circle fails to load', async () => {
      mockUseFeatureFlags.mockReturnValue(
        flagsResult({ features: { faceRecognition: true } }),
      );
      mockListPeople.mockRejectedValue(
        new Error('Request failed with status code 400'),
      );

      render(<LinkedPersonCard profile={makeProfile()} onLinkChange={vi.fn()} />);

      await waitFor(() => {
        expect(
          screen.getByText('Request failed with status code 400'),
        ).toBeInTheDocument();
      });
      // The old hard-coded fallback string must not appear.
      expect(screen.queryByText('Failed to load people.')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Unlink affordance
  // -------------------------------------------------------------------------
  describe('unlink affordance', () => {
    it('shows the linked person and an Unlink button that calls onLinkChange(null)', async () => {
      mockUseFeatureFlags.mockReturnValue(
        flagsResult({ features: { faceRecognition: true } }),
      );
      mockListPeople.mockResolvedValue({
        items: [],
        meta: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 },
      });
      const onLinkChange = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();

      render(
        <LinkedPersonCard
          profile={makeProfile({
            linkedPerson: {
              id: 'person-1',
              name: 'Grandma',
              circleId: 'circle-1',
              circleName: "Test User's Library",
            },
          })}
          onLinkChange={onLinkChange}
        />,
      );

      expect(screen.getByText('Grandma')).toBeInTheDocument();
      const unlinkButton = screen.getByRole('button', { name: /Unlink/i });
      await user.click(unlinkButton);

      await waitFor(() => {
        expect(onLinkChange).toHaveBeenCalledWith(null);
      });
    });
  });
});
