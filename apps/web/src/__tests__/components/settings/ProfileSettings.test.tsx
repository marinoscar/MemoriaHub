/**
 * ProfileSettings — unit tests.
 *
 * As of issue #354 this card is a READ-ONLY summary: display-name editing, the
 * old `useProviderImage` switch and the `customImageUrl` field all moved to the
 * `/profile` page, and those two `user_settings.profile` keys are deprecated
 * no-ops that this component must never render or write.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render, mockUser } from '../../utils/test-utils';
import { ProfileSettings } from '../../../components/settings/ProfileSettings';

describe('ProfileSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render profile card with title', () => {
      render(<ProfileSettings />);

      expect(screen.getByText('Profile')).toBeInTheDocument();
      expect(
        screen.getByText(/customize how you appear to others/i),
      ).toBeInTheDocument();
    });

    it('should render the display name and email read-only', () => {
      render(<ProfileSettings />);

      expect(screen.getByText(mockUser.displayName!)).toBeInTheDocument();
      expect(screen.getByText(mockUser.email)).toBeInTheDocument();
      // No editable fields remain on this card.
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('should show a fallback when no display name is set', () => {
      render(<ProfileSettings />, {
        wrapperOptions: { user: { ...mockUser, displayName: null } },
      });

      expect(screen.getByText('No name set')).toBeInTheDocument();
    });

    it('should render nothing when unauthenticated', () => {
      const { container } = render(<ProfileSettings />, {
        wrapperOptions: { authenticated: false },
      });

      expect(container.firstChild).toBeNull();
    });
  });

  describe('Deprecated controls are gone', () => {
    it('should not render the "Use Google profile image" switch', () => {
      render(<ProfileSettings />);

      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    });

    it('should not render an upload control', () => {
      render(<ProfileSettings />);

      expect(
        screen.queryByRole('button', { name: /upload/i }),
      ).not.toBeInTheDocument();
    });

    it('should not render a save button', () => {
      render(<ProfileSettings />);

      expect(
        screen.queryByRole('button', { name: /save/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('Link to /profile', () => {
    it('should render a "Manage profile picture" link pointing at /profile', () => {
      render(<ProfileSettings />);

      const link = screen.getByRole('link', { name: /manage profile picture/i });
      expect(link).toHaveAttribute('href', '/profile');
    });
  });

  describe('Avatar', () => {
    it('should render the provider image when one is set', () => {
      const imageUrl = 'https://example.com/provider-image.jpg';
      render(<ProfileSettings />, {
        wrapperOptions: {
          user: { ...mockUser, profileImageUrl: imageUrl },
        },
      });

      expect(screen.getByRole('img', { name: mockUser.displayName! })).toHaveAttribute(
        'src',
        imageUrl,
      );
    });

    it('should fall back to initials when there is no image', () => {
      render(<ProfileSettings />, {
        wrapperOptions: {
          user: { ...mockUser, displayName: 'John Doe', profileImageUrl: null },
        },
      });

      expect(screen.getByText('JD')).toBeInTheDocument();
    });
  });
});
