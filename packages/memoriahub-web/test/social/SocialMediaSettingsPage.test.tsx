import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render, mockAdminUser } from '../utils/test-utils.js';
import { createFakeAdminPort } from '../../src/core/testing/index.js';

vi.mock('../../src/core/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePermissions: vi.fn(),
  useMemoriahubAdmin: vi.fn(),
}));

vi.mock('../../src/social/headless/services/socialMedia.js', () => ({
  getSocialMediaStatus: vi.fn(),
  backfillSocialMedia: vi.fn(),
}));

import SocialMediaSettingsPage from '../../src/social/ui/pages/SocialMediaSettingsPage.js';
import { usePermissions, useMemoriahubAdmin } from '../../src/core/headless/index.js';
import { getSocialMediaStatus } from '../../src/social/headless/services/socialMedia.js';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseAdmin = vi.mocked(useMemoriahubAdmin);
const mockStatus = vi.mocked(getSocialMediaStatus);

describe('SocialMediaSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAdmin.mockReturnValue({
      ...createFakeAdminPort().port,
      useSystemSettings: () => ({
        settings: { features: { socialMediaDetection: true }, socialMedia: { ocrEnabled: true }, version: 1 },
        isLoading: false,
        error: null,
        isSaving: false,
        updateSettings: vi.fn().mockResolvedValue(undefined),
        refresh: vi.fn().mockResolvedValue(undefined),
      }),
    } as never);
    mockStatus.mockResolvedValue({
      ocrEnabled: true,
      ocrAvailable: true,
      degraded: false,
      modelPath: '/models/ocr',
      languages: ['eng'],
      minConfidence: 0.8,
      ocrMaxFrames: 4,
      ocrTimeoutSeconds: 60,
    });
  });

  it('keeps non-admin users out of the page', () => {
    mockUsePermissions.mockReturnValue({ isAdmin: false } as never);
    render(<SocialMediaSettingsPage />, { wrapperOptions: { user: mockAdminUser } });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('renders the heading and reads the OCR status for admins', async () => {
    mockUsePermissions.mockReturnValue({ isAdmin: true } as never);
    render(<SocialMediaSettingsPage />, { wrapperOptions: { user: mockAdminUser } });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
  });
});
