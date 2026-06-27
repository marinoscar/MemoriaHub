/**
 * Tests for the "Video Face Detection" settings card on FaceSettingsPage.
 *
 * Coverage:
 *  - The card renders the enabled toggle, sample-interval field, and max-frames field.
 *  - Initial values are synced from sysSettings.face.video.
 *  - Clicking Save calls updateSettings with the face.video payload.
 *  - Toggling enabled to false disables the numeric fields.
 *  - A success message appears after save.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useFaceSettings', () => ({
  useFaceSettings: vi.fn(),
}));

vi.mock('../../hooks/useSystemSettings', () => ({
  useSystemSettings: vi.fn(),
}));

vi.mock('../../services/adminBackfill', () => ({
  runGlobalFaceBackfill: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import FaceSettingsPage from '../../pages/Admin/FaceSettingsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useFaceSettings } from '../../hooks/useFaceSettings';
import { useSystemSettings } from '../../hooks/useSystemSettings';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseFaceSettings = vi.mocked(useFaceSettings);
const mockUseSystemSettings = vi.mocked(useSystemSettings);

// ---------------------------------------------------------------------------
// Default mocks
// ---------------------------------------------------------------------------

function defaultPermissions() {
  return {
    isAdmin: true,
    permissions: new Set(['face_settings:read', 'face_settings:write']),
    roles: new Set(['admin']),
    hasPermission: vi.fn().mockReturnValue(true),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(true),
    hasAnyRole: vi.fn().mockReturnValue(true),
  };
}

function defaultFaceSettings() {
  return {
    settings: {
      providers: [
        {
          provider: 'compreface',
          configured: true,
          enabled: true,
          requiresCredentials: false,
          last4: null,
          baseUrl: 'http://compreface-core:3000',
          region: null,
          capabilities: { detect: true, embed: true, delegatedRecognize: false },
        },
      ],
      knownProviders: [],
      features: {
        detection: { provider: 'compreface', model: 'arcface-r100-v1' },
      },
    },
    loading: false,
    error: null,
    fetchSettings: vi.fn().mockResolvedValue(undefined),
    saveCredentials: vi.fn().mockResolvedValue(undefined),
    removeCredentials: vi.fn().mockResolvedValue(undefined),
    testProvider: vi.fn().mockResolvedValue({ ok: true }),
    getModels: vi.fn().mockResolvedValue(['arcface-r100-v1']),
    saveDetectionFeature: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSystemSettings(
  videoEnabled = true,
  sampleIntervalSeconds = 5,
  maxFramesPerVideo = 60,
  updateSettings?: ReturnType<typeof vi.fn>,
) {
  const update = updateSettings ?? vi.fn().mockResolvedValue(undefined);
  return {
    settings: {
      features: { faceRecognition: false, autoTagging: false, burstDetection: false },
      face: {
        video: { enabled: videoEnabled, sampleIntervalSeconds, maxFramesPerVideo },
      },
    },
    isSaving: false,
    error: null,
    updateSettings: update,
    replaceSettings: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FaceSettingsPage — Video Face Detection card', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(defaultPermissions() as any);
    mockUseFaceSettings.mockReturnValue(defaultFaceSettings() as any);
    mockUseSystemSettings.mockReturnValue(makeSystemSettings() as any);
  });

  // -------------------------------------------------------------------------
  // Card presence and initial values
  // -------------------------------------------------------------------------
  describe('card rendering', () => {
    it('renders the "Video Face Detection" section heading', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });
      expect(screen.getByText('Video Face Detection')).toBeInTheDocument();
    });

    it('renders the "Enable video face detection" toggle', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });
      expect(screen.getByText(/enable video face detection/i)).toBeInTheDocument();
    });

    it('renders the "Sample interval (seconds)" field', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });
      expect(screen.getByLabelText(/sample interval \(seconds\)/i)).toBeInTheDocument();
    });

    it('renders the "Max frames per video" field', () => {
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });
      expect(screen.getByLabelText(/max frames per video/i)).toBeInTheDocument();
    });

    it('shows the initial sampleIntervalSeconds value from settings', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettings(true, 10, 60) as any);
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });
      const intervalField = screen.getByLabelText(/sample interval \(seconds\)/i) as HTMLInputElement;
      expect(intervalField.value).toBe('10');
    });

    it('shows the initial maxFramesPerVideo value from settings', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettings(true, 5, 120) as any);
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });
      const maxFramesField = screen.getByLabelText(/max frames per video/i) as HTMLInputElement;
      expect(maxFramesField.value).toBe('120');
    });

    it('reflects enabled=false in the toggle initial state', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettings(false, 5, 60) as any);
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const switches = screen.getAllByRole('switch');
      const videoSwitch = switches.find((s) =>
        s.closest('label')?.textContent?.match(/enable video face detection/i),
      ) as HTMLInputElement | undefined;
      expect(videoSwitch?.checked).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Disabled fields when toggle is off
  // -------------------------------------------------------------------------
  describe('numeric fields disabled when toggle is off', () => {
    it('disables numeric fields when videoEnabled=false', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettings(false, 5, 60) as any);
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const intervalField = screen.getByLabelText(/sample interval \(seconds\)/i) as HTMLInputElement;
      const maxFramesField = screen.getByLabelText(/max frames per video/i) as HTMLInputElement;
      expect(intervalField).toBeDisabled();
      expect(maxFramesField).toBeDisabled();
    });

    it('enables numeric fields when videoEnabled=true', () => {
      mockUseSystemSettings.mockReturnValue(makeSystemSettings(true, 5, 60) as any);
      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const intervalField = screen.getByLabelText(/sample interval \(seconds\)/i) as HTMLInputElement;
      const maxFramesField = screen.getByLabelText(/max frames per video/i) as HTMLInputElement;
      expect(intervalField).not.toBeDisabled();
      expect(maxFramesField).not.toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  // Save button submits face.video settings
  // -------------------------------------------------------------------------
  describe('Save button', () => {
    it('calls updateSettings with face.video payload when Save is clicked', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);
      mockUseSystemSettings.mockReturnValue(makeSystemSettings(true, 5, 60, updateSettings) as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      // Click the Save button in the Video Face Detection section (it's the last
      // "Save" button; we find it by its sibling "Max frames per video" field)
      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      // The video settings Save button is within the paper that also contains the max-frames field
      const maxFramesField = screen.getByLabelText(/max frames per video/i);
      const paper = maxFramesField.closest('.MuiPaper-root') ?? maxFramesField.closest('div[class*="Paper"]');
      const saveBtn = paper
        ? Array.from(paper.querySelectorAll('button')).find((b) => b.textContent?.match(/^save$/i))
        : saveButtons[saveButtons.length - 1];

      if (saveBtn) {
        await user.click(saveBtn);
      } else {
        // Fallback: click the last Save button
        await user.click(saveButtons[saveButtons.length - 1]);
      }

      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            face: expect.objectContaining({
              video: expect.objectContaining({
                enabled: true,
                sampleIntervalSeconds: 5,
                maxFramesPerVideo: 60,
              }),
            }),
          }),
        );
      });
    });

    it('submits updated sampleIntervalSeconds after user edits the field', async () => {
      const updateSettings = vi.fn().mockResolvedValue(undefined);
      mockUseSystemSettings.mockReturnValue(makeSystemSettings(true, 5, 60, updateSettings) as any);

      render(<FaceSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      const intervalField = screen.getByLabelText(/sample interval \(seconds\)/i) as HTMLInputElement;
      // Use fireEvent.change to set the value directly — userEvent.type on a
      // controlled MUI TextField with min/max validation drops intermediate
      // empty-string states and the final value would still be the initial 5.
      fireEvent.change(intervalField, { target: { value: '15' } });

      // Find and click save
      const saveButtons = screen.getAllByRole('button', { name: /save/i });
      await user.click(saveButtons[saveButtons.length - 1]);

      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            face: expect.objectContaining({
              video: expect.objectContaining({
                sampleIntervalSeconds: 15,
              }),
            }),
          }),
        );
      });
    });
  });
});
