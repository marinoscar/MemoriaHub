/**
 * Unit tests for ProfilePage (issue #354, profile picture management).
 *
 * `AvatarCropDialog` and `LinkedPersonCard` are stubbed out — both are
 * exercised by their own dedicated specs (AvatarCropDialog indirectly via its
 * consumers, LinkedPersonCard directly in
 * `__tests__/components/user/LinkedPersonCard.test.tsx`) — so this file can
 * focus on what ProfilePage itself owns: the avatar-source selector, the
 * Reset-to-Google disabled rule, and the refreshUser()-after-mutation contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import type { UserProfile } from '../../../services/userProfile';

const mockRefreshUser = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../contexts/AuthContext', async () => {
  const actual = await vi.importActual('../../../contexts/AuthContext');
  return {
    ...actual,
    useAuth: () => ({
      user: {
        id: 'user-1',
        email: 'user@example.com',
        displayName: 'Test User',
        profileImageUrl: null,
        roles: [{ name: 'viewer' }],
        permissions: [],
        isActive: true,
        createdAt: new Date().toISOString(),
      },
      isLoading: false,
      isAuthenticated: true,
      providers: [],
      login: vi.fn(),
      logout: vi.fn(),
      refreshUser: mockRefreshUser,
    }),
  };
});

vi.mock('../../../services/userProfile', () => ({
  getMyProfile: vi.fn(),
  updateMyProfile: vi.fn(),
  uploadMyAvatar: vi.fn(),
  applyLinkedPersonAvatar: vi.fn(),
  deleteMyAvatar: vi.fn(),
}));

vi.mock('../../../components/user/AvatarCropDialog', () => ({
  AvatarCropDialog: () => null,
}));

vi.mock('../../../components/user/LinkedPersonCard', () => ({
  LinkedPersonCard: () => <div data-testid="linked-person-card" />,
}));

import ProfilePage from '../../../pages/Profile/ProfilePage';
import {
  getMyProfile,
  updateMyProfile,
} from '../../../services/userProfile';

const mockGetMyProfile = vi.mocked(getMyProfile);
const mockUpdateMyProfile = vi.mocked(updateMyProfile);

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
    providerProfileImageUrl: 'https://provider.example/photo.jpg',
    linkedPerson: null,
    ...overrides,
  };
}

describe('ProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefreshUser.mockClear();
    mockGetMyProfile.mockResolvedValue(makeProfile());
  });

  // -------------------------------------------------------------------------
  // Renders with the three sources
  // -------------------------------------------------------------------------
  describe('avatar source selector', () => {
    it('marks "Google picture" as pressed when avatarSource is oauth', async () => {
      mockGetMyProfile.mockResolvedValue(
        makeProfile({ avatarSource: 'oauth' }),
      );

      render(<ProfilePage />);

      const group = await screen.findByRole('group', {
        name: /Profile picture source/i,
      });
      expect(within(group).getByRole('button', { name: 'Google picture' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(
        within(group).getByRole('button', { name: 'Upload an image' }),
      ).toHaveAttribute('aria-pressed', 'false');
      expect(
        within(group).getByRole('button', { name: 'My linked person' }),
      ).toHaveAttribute('aria-pressed', 'false');
    });

    it('marks "Upload an image" as pressed when avatarSource is upload', async () => {
      mockGetMyProfile.mockResolvedValue(
        makeProfile({ avatarSource: 'upload', avatarUrl: 'https://cdn.example/a.jpg' }),
      );

      render(<ProfilePage />);

      const group = await screen.findByRole('group', {
        name: /Profile picture source/i,
      });
      expect(within(group).getByRole('button', { name: 'Upload an image' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(
        within(group).getByRole('button', { name: 'Google picture' }),
      ).toHaveAttribute('aria-pressed', 'false');
    });

    it('marks "My linked person" as pressed when avatarSource is person', async () => {
      mockGetMyProfile.mockResolvedValue(
        makeProfile({
          avatarSource: 'person',
          avatarUrl: 'https://cdn.example/b.jpg',
          linkedPerson: {
            id: 'person-1',
            name: 'Grandma',
            circleId: 'circle-1',
            circleName: 'Family',
          },
        }),
      );

      render(<ProfilePage />);

      const group = await screen.findByRole('group', {
        name: /Profile picture source/i,
      });
      expect(
        within(group).getByRole('button', { name: 'My linked person' }),
      ).toHaveAttribute('aria-pressed', 'true');
    });
  });

  // -------------------------------------------------------------------------
  // Reset to Google picture — disabled without a provider image
  // -------------------------------------------------------------------------
  describe('Reset to Google picture', () => {
    it('is disabled when providerProfileImageUrl is null', async () => {
      mockGetMyProfile.mockResolvedValue(
        makeProfile({ providerProfileImageUrl: null }),
      );

      render(<ProfilePage />);

      const resetButton = await screen.findByRole('button', {
        name: 'Reset to Google picture',
      });
      expect(resetButton).toBeDisabled();
    });

    it('is enabled when a provider image is present', async () => {
      mockGetMyProfile.mockResolvedValue(
        makeProfile({ providerProfileImageUrl: 'https://provider.example/x.jpg' }),
      );

      render(<ProfilePage />);

      const resetButton = await screen.findByRole('button', {
        name: 'Reset to Google picture',
      });
      expect(resetButton).toBeEnabled();
    });
  });

  // -------------------------------------------------------------------------
  // refreshUser() after a successful mutation
  // -------------------------------------------------------------------------
  describe('refreshUser after mutation', () => {
    it('calls refreshUser() after the display name is saved', async () => {
      const user = userEvent.setup();
      mockGetMyProfile.mockResolvedValue(makeProfile({ displayName: 'Old Name' }));
      mockUpdateMyProfile.mockResolvedValue(makeProfile({ displayName: 'New Name' }));

      render(<ProfilePage />);

      const nameField = await screen.findByLabelText(/Display Name/i);
      await user.clear(nameField);
      await user.type(nameField, 'New Name');

      const saveButton = screen.getByRole('button', { name: /Save changes/i });
      await user.click(saveButton);

      await waitFor(() => {
        expect(mockUpdateMyProfile).toHaveBeenCalledWith({ displayName: 'New Name' });
      });
      await waitFor(() => {
        expect(mockRefreshUser).toHaveBeenCalled();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Totally empty install
  // -------------------------------------------------------------------------
  describe('empty install', () => {
    it('renders without crashing: no avatar, no link, no circles, no people', async () => {
      mockGetMyProfile.mockResolvedValue(
        makeProfile({
          avatarUrl: null,
          avatarSource: 'oauth',
          providerProfileImageUrl: null,
          linkedPerson: null,
        }),
      );

      expect(() =>
        render(<ProfilePage />, { wrapperOptions: { activeCircle: null } }),
      ).not.toThrow();

      await screen.findByRole('heading', { level: 1, name: 'Profile' });
      expect(
        screen.getByRole('button', { name: 'Reset to Google picture' }),
      ).toBeDisabled();
      expect(screen.getByTestId('linked-person-card')).toBeInTheDocument();
    });
  });
});
