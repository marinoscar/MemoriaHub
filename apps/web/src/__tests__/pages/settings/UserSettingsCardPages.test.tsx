/**
 * The per-user card pages (RETRO-B5, #621): each section the stacked
 * `/settings` page used to render now has a page of its own, sharing
 * `UserSettingsCardPage`'s spinner, error alert and snackbars.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';

vi.mock('../../../hooks/useUserSettings', () => ({ useUserSettings: vi.fn() }));
vi.mock('@marinoscar/memoriahub-web/memories/headless', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/memoriahub-web/memories/headless')>()),
  useMemoriesEnabled: vi.fn(),
}));

import { useUserSettings } from '../../../hooks/useUserSettings';
import { useMemoriesEnabled } from '@marinoscar/memoriahub-web/memories/headless';
import AppearanceSettingsPage from '../../../pages/settings/AppearanceSettingsPage';
import MemoriesPreferencesPage from '../../../pages/settings/MemoriesPreferencesPage';

const mockUseUserSettings = vi.mocked(useUserSettings);
const mockMemoriesEnabled = vi.mocked(useMemoriesEnabled);

function hookValue(overrides: Record<string, unknown> = {}) {
  return {
    settings: { theme: 'system', profile: {}, updatedAt: new Date().toISOString(), version: 1 },
    isLoading: false,
    error: null,
    isSaving: false,
    updateSettings: vi.fn(),
    updateTheme: vi.fn().mockResolvedValue(undefined),
    updateTimezone: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useUserSettings>;
}

describe('per-user settings card pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUserSettings.mockReturnValue(hookValue());
  });

  it('shows a spinner while the settings load', () => {
    mockUseUserSettings.mockReturnValue(hookValue({ settings: null, isLoading: true }));
    render(<AppearanceSettingsPage />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('shows the fetch error', () => {
    mockUseUserSettings.mockReturnValue(hookValue({ settings: null, error: 'Failed to load settings' }));
    render(<AppearanceSettingsPage />);
    expect(screen.getByText('Failed to load settings')).toBeInTheDocument();
  });

  it('Appearance: titles the page and saves the theme with a success message', async () => {
    const updateTheme = vi.fn().mockResolvedValue(undefined);
    mockUseUserSettings.mockReturnValue(hookValue({ updateTheme }));
    const user = userEvent.setup();
    render(<AppearanceSettingsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Appearance' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /dark/i }));
    await waitFor(() => expect(updateTheme).toHaveBeenCalledWith('dark'));
    expect(await screen.findByText('Theme updated')).toBeInTheDocument();
  });

  it('Appearance: reports a failed save', async () => {
    mockUseUserSettings.mockReturnValue(
      hookValue({ updateTheme: vi.fn().mockRejectedValue(new Error('Update failed')) }),
    );
    const user = userEvent.setup();
    render(<AppearanceSettingsPage />);
    await user.click(screen.getByRole('button', { name: /dark/i }));
    expect(await screen.findByText('Update failed')).toBeInTheDocument();
  });

  it('Memories: says so when the feature is off instead of rendering an empty page', () => {
    mockMemoriesEnabled.mockReturnValue(false);
    render(<MemoriesPreferencesPage />);
    expect(screen.getByText(/memories are turned off/i)).toBeInTheDocument();
  });
});
