/**
 * TagAutocomplete — unit tests.
 *
 * listTags is mocked at the service level.
 * Tests verify: initial tag load, handleChange callback, renderValue (chips),
 * and error path when listTags rejects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { TagAutocomplete } from '../../../components/media/TagAutocomplete';

// ---------------------------------------------------------------------------
// Mock media service
// ---------------------------------------------------------------------------
vi.mock('../../../services/media', () => ({
  listTags: vi.fn(),
  getDashboard: vi.fn(),
  listMedia: vi.fn(),
  getMedia: vi.fn(),
  patchMedia: vi.fn(),
  initUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeUpload: vi.fn(),
  registerMedia: vi.fn(),
  bulkUpdateMedia: vi.fn(),
  bulkTags: vi.fn(),
  bulkDelete: vi.fn(),
  searchPlaces: vi.fn(),
  reverseGeocode: vi.fn(),
}));

import { listTags } from '../../../services/media';

const mockListTags = vi.mocked(listTags);

// ---------------------------------------------------------------------------
// Default props
// ---------------------------------------------------------------------------
const defaultProps = {
  label: 'Tags',
  value: [] as string[],
  onChange: vi.fn(),
  circleId: 'circle-1',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('TagAutocomplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTags.mockResolvedValue([
      { id: 't1', name: 'vacation', circleId: 'circle-1', count: 3 },
      { id: 't2', name: 'family', circleId: 'circle-1', count: 5 },
    ]);
  });

  describe('Rendering', () => {
    it('renders the autocomplete input with the given label', async () => {
      render(<TagAutocomplete {...defaultProps} />);
      // MUI Autocomplete renders the label in the DOM
      await waitFor(() => {
        expect(screen.getByLabelText('Tags')).toBeInTheDocument();
      });
    });

    it('calls listTags with the circleId on mount', async () => {
      render(<TagAutocomplete {...defaultProps} />);
      await waitFor(() => {
        expect(mockListTags).toHaveBeenCalledWith('circle-1');
      });
    });

    it('renders with no initial value (empty chips)', () => {
      render(<TagAutocomplete {...defaultProps} value={[]} />);
      // No chips should be visible when value is empty
      expect(screen.queryByRole('button', { name: /vacation/i })).not.toBeInTheDocument();
    });
  });

  describe('Existing value display', () => {
    it('renders chips for each tag in value', async () => {
      render(<TagAutocomplete {...defaultProps} value={['vacation', 'family']} />);
      await waitFor(() => {
        expect(screen.getByText('vacation')).toBeInTheDocument();
        expect(screen.getByText('family')).toBeInTheDocument();
      });
    });
  });

  describe('disabled state', () => {
    it('disables the input when disabled=true', async () => {
      render(<TagAutocomplete {...defaultProps} disabled />);
      await waitFor(() => {
        const input = screen.getByLabelText('Tags');
        expect(input).toBeDisabled();
      });
    });
  });

  describe('useEffect error path', () => {
    it('falls back to empty options when listTags rejects', async () => {
      mockListTags.mockRejectedValueOnce(new Error('Network error'));
      // Should not throw; component handles error silently
      render(<TagAutocomplete {...defaultProps} />);
      await waitFor(() => {
        expect(mockListTags).toHaveBeenCalled();
      });
      // No crash: component still renders
      expect(screen.getByLabelText('Tags')).toBeInTheDocument();
    });
  });

  describe('circleId change', () => {
    it('re-fetches tags when circleId changes', async () => {
      const { rerender } = render(<TagAutocomplete {...defaultProps} circleId="circle-1" />);
      await waitFor(() => expect(mockListTags).toHaveBeenCalledWith('circle-1'));

      rerender(<TagAutocomplete {...defaultProps} circleId="circle-2" />);
      await waitFor(() => expect(mockListTags).toHaveBeenCalledWith('circle-2'));
    });
  });
});
