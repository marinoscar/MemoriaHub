/**
 * BulkTagsDialog — unit tests.
 *
 * TagAutocomplete is mocked to a simple controlled input to avoid heavy
 * dependency on the Autocomplete internals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { BulkTagsDialog } from '../../../components/media/BulkTagsDialog';

// ---------------------------------------------------------------------------
// Mock TagAutocomplete — render a simple input that calls onChange
// ---------------------------------------------------------------------------
vi.mock('../../../components/media/TagAutocomplete', () => ({
  TagAutocomplete: ({
    label,
    onChange,
    value,
  }: {
    label: string;
    onChange: (val: string[]) => void;
    value: string[];
    circleId: string;
    disabled?: boolean;
    placeholder?: string;
  }) => (
    <input
      aria-label={label}
      data-testid={`tag-input-${label}`}
      value={value.join(',')}
      onChange={(e) => {
        const val = e.target.value;
        onChange(val ? val.split(',') : []);
      }}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Mock bulkTags service
// ---------------------------------------------------------------------------
vi.mock('../../../services/media', () => ({
  bulkTags: vi.fn(),
  getDashboard: vi.fn(),
  listMedia: vi.fn(),
  getMedia: vi.fn(),
  patchMedia: vi.fn(),
  initUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeUpload: vi.fn(),
  registerMedia: vi.fn(),
  listTags: vi.fn(),
  bulkUpdateMedia: vi.fn(),
  bulkDelete: vi.fn(),
}));

import { bulkTags } from '../../../services/media';

const mockBulkTags = vi.mocked(bulkTags);

// ---------------------------------------------------------------------------
// Default props
// ---------------------------------------------------------------------------
const defaultProps = {
  open: true,
  onClose: vi.fn(),
  circleId: 'circle-1',
  ids: ['item-1', 'item-2'],
  onSuccess: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('BulkTagsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBulkTags.mockResolvedValue({ added: 2, removed: 1 });
  });

  describe('Rendering', () => {
    it('renders the dialog title with item count', () => {
      render(<BulkTagsDialog {...defaultProps} />);
      expect(screen.getByText(/edit tags for 2 items/i)).toBeInTheDocument();
    });

    it('shows "Tags to Add" section', () => {
      render(<BulkTagsDialog {...defaultProps} />);
      expect(screen.getByText(/tags to add/i)).toBeInTheDocument();
    });

    it('shows "Tags to Remove" section', () => {
      render(<BulkTagsDialog {...defaultProps} />);
      expect(screen.getByText(/tags to remove/i)).toBeInTheDocument();
    });

    it('renders Cancel and Apply buttons', () => {
      render(<BulkTagsDialog {...defaultProps} />);
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /apply/i })).toBeInTheDocument();
    });

    it('Apply button is disabled initially (no tags)', () => {
      render(<BulkTagsDialog {...defaultProps} />);
      expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
    });

    it('uses singular "item" for single id', () => {
      render(<BulkTagsDialog {...defaultProps} ids={['item-1']} />);
      expect(screen.getByText(/edit tags for 1 item$/i)).toBeInTheDocument();
    });
  });

  describe('handleClose', () => {
    it('calls onClose when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkTagsDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleApply', () => {
    it('enables Apply button when tags to add are entered', async () => {
      const user = userEvent.setup();
      render(<BulkTagsDialog {...defaultProps} />);

      const addInput = screen.getByTestId('tag-input-Add tags');
      await user.clear(addInput);
      await user.type(addInput, 'vacation');

      expect(screen.getByRole('button', { name: /apply/i })).not.toBeDisabled();
    });

    it('calls bulkTags with add tags when Apply is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkTagsDialog {...defaultProps} />);

      const addInput = screen.getByTestId('tag-input-Add tags');
      await user.clear(addInput);
      await user.type(addInput, 'vacation');

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(mockBulkTags).toHaveBeenCalledWith(
          expect.objectContaining({
            circleId: 'circle-1',
            ids: ['item-1', 'item-2'],
            add: ['vacation'],
          }),
        );
      });
    });

    it('calls bulkTags with remove tags when Apply is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkTagsDialog {...defaultProps} />);

      const removeInput = screen.getByTestId('tag-input-Remove tags');
      await user.clear(removeInput);
      await user.type(removeInput, 'draft');

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(mockBulkTags).toHaveBeenCalledWith(
          expect.objectContaining({
            remove: ['draft'],
          }),
        );
      });
    });

    it('calls onSuccess after successful apply', async () => {
      const user = userEvent.setup();
      mockBulkTags.mockResolvedValue({ added: 2, removed: 0 });
      render(<BulkTagsDialog {...defaultProps} />);

      const addInput = screen.getByTestId('tag-input-Add tags');
      await user.clear(addInput);
      await user.type(addInput, 'vacation');

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalled();
      });
    });

    it('shows error alert when bulkTags fails', async () => {
      mockBulkTags.mockRejectedValueOnce(new Error('Server error'));
      const user = userEvent.setup();
      render(<BulkTagsDialog {...defaultProps} />);

      const addInput = screen.getByTestId('tag-input-Add tags');
      await user.clear(addInput);
      await user.type(addInput, 'vacation');

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(screen.getByText(/server error/i)).toBeInTheDocument();
      });
    });

    it('shows "No changes" in success when added and removed are both 0', async () => {
      mockBulkTags.mockResolvedValue({ added: 0, removed: 0 });
      const user = userEvent.setup();
      render(<BulkTagsDialog {...defaultProps} />);

      const addInput = screen.getByTestId('tag-input-Add tags');
      await user.clear(addInput);
      await user.type(addInput, 'vacation');

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalledWith('No changes');
      });
    });
  });

  describe('Dialog not open', () => {
    it('does not render content when open is false', () => {
      render(<BulkTagsDialog {...defaultProps} open={false} />);
      expect(screen.queryByText(/edit tags for/i)).not.toBeInTheDocument();
    });
  });
});
