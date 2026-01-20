import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../../test/utils';
import { MediaMetadata } from './MediaMetadata';
import { createMockMedia } from '../../test/test-helpers';
import { mediaApi } from '../../services/api/media.api';

// Mock the media API
vi.mock('../../services/api/media.api', () => ({
  mediaApi: {
    updateMetadata: vi.fn(),
    resetMetadata: vi.fn(),
    getMedia: vi.fn(),
  },
}));

const mockMedia = createMockMedia('media-1', {
  originalFilename: 'vacation-photo.jpg',
  capturedAtUtc: '2024-06-15T14:30:00Z',
  country: 'United States',
  state: 'California',
  city: 'San Francisco',
  cameraMake: 'Canon',
  cameraModel: 'EOS R5',
  width: 4000,
  height: 3000,
  fileSize: 5242880, // 5 MB
});

const mockVideoMedia = createMockMedia('media-2', {
  originalFilename: 'family-video.mp4',
  mediaType: 'video',
  mimeType: 'video/mp4',
  durationSeconds: 125,
  capturedAtUtc: '2024-06-15T14:30:00Z',
  country: 'United States',
  state: 'California',
  city: 'San Francisco',
});

describe('MediaMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('read-only mode', () => {
    it('displays filename', () => {
      render(<MediaMetadata media={mockMedia} />);
      expect(screen.getByText('vacation-photo.jpg')).toBeInTheDocument();
    });

    it('displays captured date', () => {
      render(<MediaMetadata media={mockMedia} />);
      expect(screen.getByText('Captured')).toBeInTheDocument();
      // Date is formatted by locale, so just check it's not "Not set"
      expect(screen.queryByText('Not set')).not.toBeInTheDocument();
    });

    it('displays "Not set" when captured date is null', () => {
      const mediaWithoutDate = createMockMedia('media-3', {
        capturedAtUtc: null,
        country: 'Test Country', // Need some location to avoid multiple "Not set"
        state: 'Test State',
        city: 'Test City',
      });
      render(<MediaMetadata media={mediaWithoutDate} />);
      // The captured date field should show "Not set"
      const capturedLabel = screen.getByText('Captured');
      const capturedValue = capturedLabel.parentElement?.querySelector('p');
      expect(capturedValue?.textContent).toBe('Not set');
    });

    it('displays location as separate Country, State, City fields', () => {
      render(<MediaMetadata media={mockMedia} />);
      expect(screen.getByText('Country')).toBeInTheDocument();
      expect(screen.getByText('United States')).toBeInTheDocument();
      expect(screen.getByText('State')).toBeInTheDocument();
      expect(screen.getByText('California')).toBeInTheDocument();
      expect(screen.getByText('City')).toBeInTheDocument();
      expect(screen.getByText('San Francisco')).toBeInTheDocument();
    });

    it('displays camera info when available', () => {
      render(<MediaMetadata media={mockMedia} />);
      expect(screen.getByText('Camera')).toBeInTheDocument();
      expect(screen.getByText('Canon EOS R5')).toBeInTheDocument();
    });

    it('displays dimensions when available', () => {
      render(<MediaMetadata media={mockMedia} />);
      expect(screen.getByText('Dimensions')).toBeInTheDocument();
      expect(screen.getByText('4000 x 3000')).toBeInTheDocument();
    });

    it('displays file size', () => {
      render(<MediaMetadata media={mockMedia} />);
      expect(screen.getByText('File size')).toBeInTheDocument();
      expect(screen.getByText('5 MB')).toBeInTheDocument();
    });

    it('displays duration for videos', () => {
      render(<MediaMetadata media={mockVideoMedia} />);
      expect(screen.getByText('Duration')).toBeInTheDocument();
      expect(screen.getByText('2:05')).toBeInTheDocument();
    });

    it('does not display duration for images', () => {
      render(<MediaMetadata media={mockMedia} />);
      expect(screen.queryByText('Duration')).not.toBeInTheDocument();
    });

    it('shows Edit Metadata button', () => {
      render(<MediaMetadata media={mockMedia} />);
      expect(screen.getByRole('button', { name: /edit metadata/i })).toBeInTheDocument();
    });
  });

  describe('edit mode', () => {
    it('shows editable fields when Edit is clicked', () => {
      render(<MediaMetadata media={mockMedia} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));

      // Should now have text inputs for location fields
      expect(screen.getByLabelText('Country')).toBeInTheDocument();
      expect(screen.getByLabelText('State')).toBeInTheDocument();
      expect(screen.getByLabelText('City')).toBeInTheDocument();
      expect(screen.getByLabelText('Captured')).toBeInTheDocument();
    });

    it('populates form fields with current values', () => {
      render(<MediaMetadata media={mockMedia} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));

      expect(screen.getByLabelText('Country')).toHaveValue('United States');
      expect(screen.getByLabelText('State')).toHaveValue('California');
      expect(screen.getByLabelText('City')).toHaveValue('San Francisco');
    });

    it('allows editing Country field', () => {
      render(<MediaMetadata media={mockMedia} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));

      const countryInput = screen.getByLabelText('Country');
      fireEvent.change(countryInput, { target: { value: 'Canada' } });

      expect(countryInput).toHaveValue('Canada');
    });

    it('allows editing State field', () => {
      render(<MediaMetadata media={mockMedia} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));

      const stateInput = screen.getByLabelText('State');
      fireEvent.change(stateInput, { target: { value: 'Ontario' } });

      expect(stateInput).toHaveValue('Ontario');
    });

    it('allows editing City field', () => {
      render(<MediaMetadata media={mockMedia} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));

      const cityInput = screen.getByLabelText('City');
      fireEvent.change(cityInput, { target: { value: 'Toronto' } });

      expect(cityInput).toHaveValue('Toronto');
    });

    it('shows Save, Reset to Defaults, and Cancel buttons', () => {
      render(<MediaMetadata media={mockMedia} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));

      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reset to defaults/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });
  });

  describe('save functionality', () => {
    it('calls updateMetadata API on save', async () => {
      const mockOnSave = vi.fn();
      const updatedMedia = { ...mockMedia, country: 'Canada' };

      vi.mocked(mediaApi.updateMetadata).mockResolvedValue({
        updated: ['media-1'],
        failed: [],
      });
      vi.mocked(mediaApi.getMedia).mockResolvedValue(updatedMedia);

      render(<MediaMetadata media={mockMedia} onSave={mockOnSave} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));

      const countryInput = screen.getByLabelText('Country');
      fireEvent.change(countryInput, { target: { value: 'Canada' } });

      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(mediaApi.updateMetadata).toHaveBeenCalledWith('media-1', expect.objectContaining({
          country: 'Canada',
        }));
      });
    });

    it('calls onSave callback with updated media after successful save', async () => {
      const mockOnSave = vi.fn();
      const updatedMedia = { ...mockMedia, country: 'Canada' };

      vi.mocked(mediaApi.updateMetadata).mockResolvedValue({
        updated: ['media-1'],
        failed: [],
      });
      vi.mocked(mediaApi.getMedia).mockResolvedValue(updatedMedia);

      render(<MediaMetadata media={mockMedia} onSave={mockOnSave} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(updatedMedia);
      });
    });

    it('exits edit mode after successful save', async () => {
      vi.mocked(mediaApi.updateMetadata).mockResolvedValue({
        updated: ['media-1'],
        failed: [],
      });
      vi.mocked(mediaApi.getMedia).mockResolvedValue(mockMedia);

      render(<MediaMetadata media={mockMedia} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /edit metadata/i })).toBeInTheDocument();
      });
    });

    it('calls onError when save fails', async () => {
      const mockOnError = vi.fn();

      vi.mocked(mediaApi.updateMetadata).mockResolvedValue({
        updated: [],
        failed: [{ assetId: 'media-1', error: 'Update failed' }],
      });

      render(<MediaMetadata media={mockMedia} onError={mockOnError} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(mockOnError).toHaveBeenCalledWith('Update failed');
      });
    });
  });

  describe('reset functionality', () => {
    it('calls resetMetadata API', async () => {
      vi.mocked(mediaApi.resetMetadata).mockResolvedValue(mockMedia);

      render(<MediaMetadata media={mockMedia} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));
      fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));

      await waitFor(() => {
        expect(mediaApi.resetMetadata).toHaveBeenCalledWith('media-1');
      });
    });

    it('calls onSave with reset media after successful reset', async () => {
      const mockOnSave = vi.fn();
      const resetMedia = { ...mockMedia, country: 'Germany' };

      vi.mocked(mediaApi.resetMetadata).mockResolvedValue(resetMedia);

      render(<MediaMetadata media={mockMedia} onSave={mockOnSave} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));
      fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith(resetMedia);
      });
    });

    it('exits edit mode after successful reset', async () => {
      vi.mocked(mediaApi.resetMetadata).mockResolvedValue(mockMedia);

      render(<MediaMetadata media={mockMedia} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));
      fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /edit metadata/i })).toBeInTheDocument();
      });
    });

    it('calls onError when reset fails', async () => {
      const mockOnError = vi.fn();

      vi.mocked(mediaApi.resetMetadata).mockRejectedValue(new Error('Reset failed'));

      render(<MediaMetadata media={mockMedia} onError={mockOnError} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));
      fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));

      await waitFor(() => {
        expect(mockOnError).toHaveBeenCalledWith('Reset failed');
      });
    });
  });

  describe('cancel functionality', () => {
    it('reverts changes when Cancel is clicked', () => {
      render(<MediaMetadata media={mockMedia} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));

      const countryInput = screen.getByLabelText('Country');
      fireEvent.change(countryInput, { target: { value: 'Canada' } });
      expect(countryInput).toHaveValue('Canada');

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

      // Re-enter edit mode to check values were reverted
      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));
      expect(screen.getByLabelText('Country')).toHaveValue('United States');
    });

    it('exits edit mode when Cancel is clicked', () => {
      render(<MediaMetadata media={mockMedia} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.getByRole('button', { name: /edit metadata/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });
  });

  describe('media change handling', () => {
    it('exits edit mode when media changes', () => {
      const { rerender } = render(<MediaMetadata media={mockMedia} />);

      fireEvent.click(screen.getByRole('button', { name: /edit metadata/i }));
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();

      const newMedia = createMockMedia('media-different', {
        originalFilename: 'different-photo.jpg',
      });
      rerender(<MediaMetadata media={newMedia} />);

      expect(screen.getByRole('button', { name: /edit metadata/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });
  });
});
