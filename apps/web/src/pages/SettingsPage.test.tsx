/**
 * SettingsPage Component Tests
 *
 * Tests for user preferences management, theme sync, and settings updates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../test/utils';
import { SettingsPage } from './SettingsPage';
import type { UserPreferencesDTO } from '@memoriahub/shared';

// Mock hooks
const mockSetTheme = vi.fn();
let mockIsDarkMode = true;

vi.mock('../hooks', () => ({
  useTheme: () => ({
    isDarkMode: mockIsDarkMode,
    setTheme: mockSetTheme,
  }),
  useAuth: () => ({
    isAuthenticated: true,
  }),
}));

// Mock settings API
const mockGetPreferences = vi.fn();
const mockUpdatePreferences = vi.fn();
const mockResetPreferences = vi.fn();

vi.mock('../services/api/settings.api', () => ({
  settingsApi: {
    getPreferences: () => mockGetPreferences(),
    updatePreferences: (data: Record<string, unknown>) => mockUpdatePreferences(data),
    resetPreferences: () => mockResetPreferences(),
  },
}));

const createMockPreferences = (overrides: Partial<UserPreferencesDTO['preferences']> = {}): UserPreferencesDTO => ({
  userId: 'user-123',
  preferences: {
    ui: {
      theme: 'dark',
      gridSize: 'medium',
      showMetadata: true,
      ...overrides.ui,
    },
    notifications: {
      email: {
        enabled: false,
        digest: 'daily',
      },
      push: {
        enabled: false,
      },
      ...overrides.notifications,
    },
    privacy: {
      defaultAlbumVisibility: 'private',
      allowTagging: true,
      ...overrides.privacy,
    },
  },
  updatedAt: '2024-01-01T00:00:00Z',
});

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDarkMode = true;
    mockGetPreferences.mockResolvedValue(createMockPreferences());
    mockUpdatePreferences.mockImplementation(async () => createMockPreferences());
    mockResetPreferences.mockResolvedValue(createMockPreferences());
  });

  describe('initial load', () => {
    it('shows loading state initially', () => {
      // Don't resolve the promise
      mockGetPreferences.mockImplementation(() => new Promise(() => {}));

      render(<SettingsPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('fetches preferences on mount', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(mockGetPreferences).toHaveBeenCalled();
      });
    });

    it('displays preferences after loading', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
        expect(screen.getByText('Appearance')).toBeInTheDocument();
      });
    });

    it('shows error state if fetch fails', async () => {
      mockGetPreferences.mockRejectedValue(new Error('Network error'));

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load preferences')).toBeInTheDocument();
      });
    });
  });

  describe('theme sync', () => {
    it('syncs theme context with server preference (dark)', async () => {
      mockIsDarkMode = false; // Currently light
      mockGetPreferences.mockResolvedValue(createMockPreferences({ ui: { theme: 'dark', gridSize: 'medium', showMetadata: true } }));

      render(<SettingsPage />);

      await waitFor(() => {
        expect(mockSetTheme).toHaveBeenCalledWith('dark');
      });
    });

    it('syncs theme context with server preference (light)', async () => {
      mockIsDarkMode = true; // Currently dark
      mockGetPreferences.mockResolvedValue(createMockPreferences({ ui: { theme: 'light', gridSize: 'medium', showMetadata: true } }));

      render(<SettingsPage />);

      await waitFor(() => {
        expect(mockSetTheme).toHaveBeenCalledWith('light');
      });
    });

    it('does not call setTheme if already matches', async () => {
      mockIsDarkMode = true;
      mockGetPreferences.mockResolvedValue(createMockPreferences({ ui: { theme: 'dark', gridSize: 'medium', showMetadata: true } }));

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Appearance')).toBeInTheDocument();
      });

      // setTheme should not be called if theme already matches
      expect(mockSetTheme).not.toHaveBeenCalled();
    });
  });

  describe('appearance settings', () => {
    it('renders theme selector with current value', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Theme')).toBeInTheDocument();
      });

      // There should be a select with Dark value
      expect(screen.getByRole('combobox', { name: '' })).toBeInTheDocument();
    });

    it('renders grid size selector', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Grid Size')).toBeInTheDocument();
      });
    });

    it('renders show metadata toggle', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Show Metadata')).toBeInTheDocument();
      });

      // Should have a switch
      const switches = screen.getAllByRole('checkbox');
      expect(switches.length).toBeGreaterThan(0);
    });

    it('updates grid size when changed', async () => {
      mockUpdatePreferences.mockResolvedValue(createMockPreferences({ ui: { theme: 'dark', gridSize: 'large', showMetadata: true } }));

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Grid Size')).toBeInTheDocument();
      });

      // Find and click the grid size select
      const selects = screen.getAllByRole('combobox');
      const gridSizeSelect = selects[1]; // Second select is grid size

      fireEvent.mouseDown(gridSizeSelect);

      await waitFor(() => {
        expect(screen.getByText('Large')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Large'));

      await waitFor(() => {
        expect(mockUpdatePreferences).toHaveBeenCalledWith(
          expect.objectContaining({
            ui: expect.objectContaining({
              gridSize: 'large',
            }),
          })
        );
      });
    });

    it('updates show metadata when toggled', async () => {
      mockUpdatePreferences.mockResolvedValue(createMockPreferences({ ui: { theme: 'dark', gridSize: 'medium', showMetadata: false } }));

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Show Metadata')).toBeInTheDocument();
      });

      // Find the show metadata switch
      const showMetadataLabel = screen.getByText('Show Metadata');
      const listItem = showMetadataLabel.closest('li');
      const toggle = listItem?.querySelector('input[type="checkbox"]');

      fireEvent.click(toggle!);

      await waitFor(() => {
        expect(mockUpdatePreferences).toHaveBeenCalled();
      });
    });
  });

  describe('notification settings', () => {
    it('renders email notifications toggle', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Email Notifications')).toBeInTheDocument();
      });
    });

    it('updates email notifications when toggled', async () => {
      mockUpdatePreferences.mockResolvedValue(createMockPreferences({
        notifications: {
          email: { enabled: true, digest: 'daily' },
          push: { enabled: false },
        },
      }));

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Email Notifications')).toBeInTheDocument();
      });

      const emailLabel = screen.getByText('Email Notifications');
      const listItem = emailLabel.closest('li');
      const toggle = listItem?.querySelector('input[type="checkbox"]');

      fireEvent.click(toggle!);

      await waitFor(() => {
        expect(mockUpdatePreferences).toHaveBeenCalledWith(
          expect.objectContaining({
            notifications: expect.objectContaining({
              email: expect.objectContaining({
                enabled: true,
              }),
            }),
          })
        );
      });
    });

    it('renders push notifications toggle', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Push Notifications')).toBeInTheDocument();
      });
    });
  });

  describe('privacy settings', () => {
    it('renders default visibility selector', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Default Album Visibility')).toBeInTheDocument();
      });
    });

    it('renders allow tagging toggle', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Allow Tagging')).toBeInTheDocument();
      });
    });

    it('updates allow tagging when toggled', async () => {
      mockUpdatePreferences.mockResolvedValue(createMockPreferences({
        privacy: { defaultAlbumVisibility: 'private', allowTagging: false },
      }));

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Allow Tagging')).toBeInTheDocument();
      });

      const allowTaggingLabel = screen.getByText('Allow Tagging');
      const listItem = allowTaggingLabel.closest('li');
      const toggle = listItem?.querySelector('input[type="checkbox"]');

      fireEvent.click(toggle!);

      await waitFor(() => {
        expect(mockUpdatePreferences).toHaveBeenCalled();
      });
    });
  });

  describe('preference updates', () => {
    it('calls API with correct nested path for theme', async () => {
      mockUpdatePreferences.mockResolvedValue(createMockPreferences({ ui: { theme: 'light', gridSize: 'medium', showMetadata: true } }));

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Theme')).toBeInTheDocument();
      });

      const themeSelect = screen.getAllByRole('combobox')[0];
      fireEvent.mouseDown(themeSelect);

      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'Light' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('option', { name: 'Light' }));

      await waitFor(() => {
        expect(mockUpdatePreferences).toHaveBeenCalledWith(
          expect.objectContaining({
            ui: expect.objectContaining({
              theme: 'light',
            }),
          })
        );
      });
    });

    it('shows success snackbar after update', async () => {
      mockUpdatePreferences.mockResolvedValue(createMockPreferences());

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Show Metadata')).toBeInTheDocument();
      });

      const showMetadataLabel = screen.getByText('Show Metadata');
      const listItem = showMetadataLabel.closest('li');
      const toggle = listItem?.querySelector('input[type="checkbox"]');

      fireEvent.click(toggle!);

      await waitFor(() => {
        expect(screen.getByText('Settings saved')).toBeInTheDocument();
      });
    });

    it('shows error state if update fails', async () => {
      mockUpdatePreferences.mockRejectedValue(new Error('Update failed'));

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Show Metadata')).toBeInTheDocument();
      });

      const showMetadataLabel = screen.getByText('Show Metadata');
      const listItem = showMetadataLabel.closest('li');
      const toggle = listItem?.querySelector('input[type="checkbox"]');

      fireEvent.click(toggle!);

      await waitFor(() => {
        expect(screen.getByText('Failed to save settings')).toBeInTheDocument();
      });
    });
  });

  describe('reset to defaults', () => {
    it('calls reset API when clicked', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Reset to Defaults')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Reset to Defaults'));

      await waitFor(() => {
        expect(mockResetPreferences).toHaveBeenCalled();
      });
    });

    it('shows success message after reset', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Reset to Defaults')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Reset to Defaults'));

      await waitFor(() => {
        expect(screen.getByText('Preferences reset to defaults')).toBeInTheDocument();
      });
    });

    it('reloads preferences after reset', async () => {
      const resetPrefs = createMockPreferences({ ui: { theme: 'dark', gridSize: 'medium', showMetadata: true } });
      mockResetPreferences.mockResolvedValue(resetPrefs);

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Reset to Defaults')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Reset to Defaults'));

      await waitFor(() => {
        expect(mockResetPreferences).toHaveBeenCalled();
      });
    });
  });

  describe('page structure', () => {
    it('renders page title', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
      });
    });

    it('renders all settings sections', async () => {
      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText('Appearance')).toBeInTheDocument();
        expect(screen.getByText('Notifications')).toBeInTheDocument();
        expect(screen.getByText('Privacy')).toBeInTheDocument();
      });
    });
  });
});
