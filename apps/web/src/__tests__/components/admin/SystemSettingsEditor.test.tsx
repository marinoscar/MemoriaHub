/**
 * SystemSettingsEditor — unit tests.
 *
 * Tests the JSON editor component for admin system settings.
 * The component renders a textarea with JSON content and a Save button.
 *
 * Note: userEvent.type is avoided for JSON strings because curly braces are
 * special characters in @testing-library/user-event. fireEvent.change is used
 * instead for textarea manipulation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { SystemSettingsEditor } from '../../../components/admin/SystemSettingsEditor';
import type { SystemSettings } from '../../../types';

const defaultSettings: SystemSettings = {
  ui: {
    allowUserThemeOverride: true,
  },
  features: {
    enablePublicSharing: false,
  },
  version: 1,
  updatedAt: new Date().toISOString(),
  updatedBy: null,
};

const validJson = JSON.stringify(
  { ui: { allowUserThemeOverride: false }, features: { enablePublicSharing: false } },
  null,
  2,
);

const defaultProps = {
  settings: defaultSettings,
  onSave: vi.fn().mockResolvedValue(undefined),
};

describe('SystemSettingsEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultProps.onSave.mockResolvedValue(undefined);
  });

  describe('Rendering', () => {
    it('renders the Advanced JSON Editor heading', () => {
      render(<SystemSettingsEditor {...defaultProps} />);
      expect(screen.getByText(/advanced json editor/i)).toBeInTheDocument();
    });

    it('renders a textarea', () => {
      render(<SystemSettingsEditor {...defaultProps} />);
      const textarea = document.querySelector('textarea');
      expect(textarea).toBeTruthy();
    });

    it('textarea contains allowUserThemeOverride in the JSON', () => {
      render(<SystemSettingsEditor {...defaultProps} />);
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea.value).toContain('allowUserThemeOverride');
    });

    it('renders the Save Changes button', () => {
      render(<SystemSettingsEditor {...defaultProps} />);
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });

    it('Save button is disabled when there are no changes', () => {
      render(<SystemSettingsEditor {...defaultProps} />);
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });

    it('renders the info alert about JSON editing', () => {
      render(<SystemSettingsEditor {...defaultProps} />);
      expect(screen.getByText(/edit the raw json settings/i)).toBeInTheDocument();
    });
  });

  describe('handleSave — valid JSON', () => {
    it('enables Save button when JSON is modified', async () => {
      render(<SystemSettingsEditor {...defaultProps} />);
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: validJson } });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled();
      });
    });

    it('calls onSave with parsed JSON when Save is clicked', async () => {
      const user = userEvent.setup();
      render(<SystemSettingsEditor {...defaultProps} />);
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: validJson } });

      await waitFor(() => expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled());
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(defaultProps.onSave).toHaveBeenCalledWith(
          expect.objectContaining({ ui: expect.objectContaining({ allowUserThemeOverride: false }) }),
        );
      });
    });

    it('shows Saving… text while onSave is in progress', async () => {
      let resolveOnSave!: () => void;
      const slowSave = vi.fn(
        () => new Promise<void>((res) => { resolveOnSave = res; }),
      );

      const user = userEvent.setup();
      render(<SystemSettingsEditor {...defaultProps} onSave={slowSave} />);
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: validJson } });
      await waitFor(() => expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled());
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /saving/i })).toBeInTheDocument();
      });

      resolveOnSave();
    });
  });

  describe('handleSave — invalid JSON', () => {
    it('shows an error when the JSON is invalid', async () => {
      const user = userEvent.setup();
      render(<SystemSettingsEditor {...defaultProps} />);
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: 'not valid json !!!' } });

      await waitFor(() => expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled());
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        // An error alert should appear
        const alerts = screen.getAllByRole('alert');
        expect(alerts.length).toBeGreaterThan(0);
      });
      expect(defaultProps.onSave).not.toHaveBeenCalled();
    });

    it('shows an error when ui.allowUserThemeOverride is not a boolean', async () => {
      const user = userEvent.setup();
      const badJson = JSON.stringify(
        { ui: { allowUserThemeOverride: 'yes' }, features: { enablePublicSharing: false } },
        null,
        2,
      );

      render(<SystemSettingsEditor {...defaultProps} />);
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: badJson } });

      await waitFor(() => expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled());
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(screen.getByText(/allowUserThemeOverride must be a boolean/i)).toBeInTheDocument();
      });
    });

    it('shows error when settings root is not an object', async () => {
      const user = userEvent.setup();
      render(<SystemSettingsEditor {...defaultProps} />);
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: '"just a string"' } });

      await waitFor(() => expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled());
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(screen.getByText(/settings must be an object/i)).toBeInTheDocument();
      });
    });
  });

  describe('onSave error handling', () => {
    it('shows error when onSave rejects', async () => {
      defaultProps.onSave.mockRejectedValueOnce(new Error('Server error'));
      const user = userEvent.setup();

      render(<SystemSettingsEditor {...defaultProps} />);
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: validJson } });
      await waitFor(() => expect(screen.getByRole('button', { name: /save changes/i })).not.toBeDisabled());
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(screen.getByText(/server error/i)).toBeInTheDocument();
      });
    });
  });

  describe('disabled state', () => {
    it('disables the textarea when disabled=true', () => {
      render(<SystemSettingsEditor {...defaultProps} disabled />);
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea).toBeDisabled();
    });

    it('disables the Save button when disabled=true', () => {
      render(<SystemSettingsEditor {...defaultProps} disabled />);
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });
  });

  describe('settings update (useEffect)', () => {
    it('resets JSON when settings prop changes', async () => {
      const { rerender } = render(<SystemSettingsEditor {...defaultProps} />);

      const updatedSettings: SystemSettings = {
        ...defaultSettings,
        ui: { allowUserThemeOverride: false },
      };

      rerender(<SystemSettingsEditor {...defaultProps} settings={updatedSettings} />);

      await waitFor(() => {
        const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
        expect(textarea.value).toContain('"allowUserThemeOverride": false');
      });
    });
  });
});
