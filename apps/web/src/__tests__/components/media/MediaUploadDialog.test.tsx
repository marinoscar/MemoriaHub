/**
 * Component tests — MediaUploadDialog
 *
 * Mocking strategy:
 *   The four media service functions used inside MediaUploadDialog
 *   (initUpload, uploadPart, completeUpload, registerMedia) are all
 *   module-level mocks via vi.mock('../../services/media').  No real
 *   fetch or presigned-URL PUT is made.
 *
 *   The global fetch used by uploadPart is NOT called because uploadPart
 *   itself is mocked — no additional fetch mock needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { MediaUploadDialog } from '../../../components/media/MediaUploadDialog';

// ---------------------------------------------------------------------------
// Mock the media service
// ---------------------------------------------------------------------------

vi.mock('../../../services/media', () => ({
  initUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeUpload: vi.fn(),
  registerMedia: vi.fn(),
}));

import {
  initUpload,
  uploadPart,
  completeUpload,
  registerMedia,
} from '../../../services/media';

const mockInitUpload = vi.mocked(initUpload);
const mockUploadPart = vi.mocked(uploadPart);
const mockCompleteUpload = vi.mocked(completeUpload);
const mockRegisterMedia = vi.mocked(registerMedia);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OBJECT_ID = 'test-object-id';

/** Returns an initUpload response for a single-part upload of a tiny file. */
function makeInitUploadResponse() {
  return {
    objectId: OBJECT_ID,
    uploadId: 'upload-id-001',
    partSize: 5 * 1024 * 1024, // 5 MB
    totalParts: 1,
    presignedUrls: [{ partNumber: 1, url: 'https://s3.example.com/presigned?part=1' }],
  };
}

/** Creates a minimal valid File for testing. */
function makeImageFile(name = 'photo.jpg', mimeType = 'image/jpeg', sizeBytes = 1024) {
  return new File([new Uint8Array(sizeBytes)], name, { type: mimeType });
}

function makeVideoFile(name = 'clip.mp4', sizeBytes = 2048) {
  return new File([new Uint8Array(sizeBytes)], name, { type: 'video/mp4' });
}

/** Returns the hidden file input. */
function getFileInput() {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

// ---------------------------------------------------------------------------
// Default props
// ---------------------------------------------------------------------------

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  onSuccess: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaUploadDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Happy-path defaults
    mockInitUpload.mockResolvedValue(makeInitUploadResponse());
    mockUploadPart.mockResolvedValue('"etag-001"');
    mockCompleteUpload.mockResolvedValue(undefined as any);
    mockRegisterMedia.mockResolvedValue({ id: 'media-001' } as any);
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe('rendering', () => {
    it('should render the dialog title', () => {
      render(<MediaUploadDialog {...defaultProps} />);
      expect(screen.getByText(/upload media/i)).toBeInTheDocument();
    });

    it('should render a hidden file input accepting image/* and video/*', () => {
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      expect(input).not.toBeNull();
      expect(input.accept).toContain('image/*');
      expect(input.accept).toContain('video/*');
      expect(input.multiple).toBe(true);
    });

    it('should render a Cancel button initially', () => {
      render(<MediaUploadDialog {...defaultProps} />);
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('should not render the Upload N file(s) button when no files are selected', () => {
      render(<MediaUploadDialog {...defaultProps} />);
      // The "Upload N file(s)" contained button should not exist without files;
      // only the Close-icon button and the Cancel button are present.
      expect(screen.queryByRole('button', { name: /upload \d+ file/i })).not.toBeInTheDocument();
    });

    it('should not render when open=false', () => {
      render(<MediaUploadDialog {...defaultProps} open={false} />);
      // Dialog is not in DOM when closed (MUI Dialog with keepMounted=false)
      expect(screen.queryByText(/upload media/i)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // File selection
  // -------------------------------------------------------------------------

  describe('file selection', () => {
    it('should display selected image file name', async () => {
      render(<MediaUploadDialog {...defaultProps} />);
      const file = makeImageFile('sunset.jpg');
      const input = getFileInput();

      fireEvent.change(input, { target: { files: [file] } });

      await waitFor(() => {
        expect(screen.getByText('sunset.jpg')).toBeInTheDocument();
      });
    });

    it('should display selected video file name', async () => {
      render(<MediaUploadDialog {...defaultProps} />);
      const file = makeVideoFile('holiday.mp4');
      const input = getFileInput();

      fireEvent.change(input, { target: { files: [file] } });

      await waitFor(() => {
        expect(screen.getByText('holiday.mp4')).toBeInTheDocument();
      });
    });

    it('should display multiple selected files', async () => {
      render(<MediaUploadDialog {...defaultProps} />);
      const files = [
        makeImageFile('img1.jpg'),
        makeImageFile('img2.png', 'image/png'),
        makeVideoFile('vid1.mp4'),
      ];
      const input = getFileInput();

      fireEvent.change(input, { target: { files } });

      await waitFor(() => {
        expect(screen.getByText('img1.jpg')).toBeInTheDocument();
        expect(screen.getByText('img2.png')).toBeInTheDocument();
        expect(screen.getByText('vid1.mp4')).toBeInTheDocument();
      });
    });

    it('should show an Upload N file(s) button after file selection', async () => {
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile()] } });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /upload 1 file/i })).toBeInTheDocument();
      });
    });

    it('should show a validation warning for non-image/non-video files', async () => {
      render(<MediaUploadDialog {...defaultProps} />);
      const textFile = new File(['hello'], 'doc.txt', { type: 'text/plain' });
      const input = getFileInput();

      fireEvent.change(input, { target: { files: [textFile] } });

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
    });

    it('should show a warning for files exceeding 500 MB', async () => {
      render(<MediaUploadDialog {...defaultProps} />);
      // Create a fake large file by overriding size
      const largeFile = Object.defineProperty(
        makeImageFile('huge.jpg', 'image/jpeg', 1),
        'size',
        { value: 501 * 1024 * 1024 },
      );
      const input = getFileInput();

      fireEvent.change(input, { target: { files: [largeFile] } });

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Successful upload flow
  // -------------------------------------------------------------------------

  describe('successful upload flow', () => {
    it('should call initUpload when the Upload button is clicked', async () => {
      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('photo.jpg')] } });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => {
        expect(mockInitUpload).toHaveBeenCalledTimes(1);
      });
    });

    it('should call uploadPart with the presigned URL and chunk', async () => {
      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile()] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => expect(mockUploadPart).toHaveBeenCalledTimes(1));
      expect(mockUploadPart).toHaveBeenCalledWith(
        'https://s3.example.com/presigned?part=1',
        expect.any(Blob),
      );
    });

    it('should call completeUpload after all parts are uploaded', async () => {
      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile()] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => expect(mockCompleteUpload).toHaveBeenCalledTimes(1));
      expect(mockCompleteUpload).toHaveBeenCalledWith(
        OBJECT_ID,
        expect.arrayContaining([
          expect.objectContaining({ partNumber: 1, eTag: '"etag-001"' }),
        ]),
      );
    });

    it('should call registerMedia after completeUpload', async () => {
      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('test.jpg')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => expect(mockRegisterMedia).toHaveBeenCalledTimes(1));
      expect(mockRegisterMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          storageObjectId: OBJECT_ID,
          type: 'photo',
          source: 'web',
          originalFilename: 'test.jpg',
        }),
      );
    });

    it('should detect video type when uploading a video file', async () => {
      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeVideoFile('clip.mp4')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => expect(mockRegisterMedia).toHaveBeenCalledTimes(1));
      expect(mockRegisterMedia).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'video' }),
      );
    });

    it('should show a success alert after all files uploaded', async () => {
      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile()] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/all files uploaded successfully/i),
        ).toBeInTheDocument();
      });
    });

    it('should replace Cancel with Close after all files succeed', async () => {
      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile()] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => {
        // The Cancel button text changes to "Close" after all succeed
        // (it's in the DialogActions, not the header icon button)
        const closeButtons = screen.getAllByRole('button', { name: /close/i });
        // At least one of them is the Cancel→Close text button in DialogActions
        const dialogCloseBtn = closeButtons.find(
          (b) => b.tagName === 'BUTTON' && !b.getAttribute('aria-label'),
        );
        expect(dialogCloseBtn).toBeDefined();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Error path + retry
  // -------------------------------------------------------------------------

  describe('error path and retry', () => {
    it('should show the file error message when uploadPart fails', async () => {
      mockUploadPart.mockRejectedValue(new Error('Network timeout'));
      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('photo.jpg')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => {
        expect(screen.getByText(/network timeout/i)).toBeInTheDocument();
      });
    });

    it('should render a retry button when a file fails to upload', async () => {
      mockUploadPart.mockRejectedValue(new Error('S3 error'));
      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('photo.jpg')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /retry uploading photo.jpg/i }),
        ).toBeInTheDocument();
      });
    });

    it('should not call onSuccess when a file fails', async () => {
      mockUploadPart.mockRejectedValue(new Error('fail'));
      const onSuccess = vi.fn();
      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} onSuccess={onSuccess} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('onSuccess.jpg')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => {
        // Error shown means upload finished — the per-file retry button appears
        expect(
          screen.getByRole('button', { name: /retry uploading onSuccess.jpg/i }),
        ).toBeInTheDocument();
      });

      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('should reset file to pending after clicking retry', async () => {
      mockUploadPart.mockRejectedValue(new Error('fail'));
      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('retry.jpg')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /retry uploading retry.jpg/i }),
        ).toBeInTheDocument();
      });

      // Click the per-file retry icon button
      await user.click(
        screen.getByRole('button', { name: /retry uploading retry.jpg/i }),
      );

      // After retry click the file returns to pending (shows "Retry Failed" bulk button
      // or the Upload button again, and the error text should be cleared)
      await waitFor(() => {
        expect(screen.queryByText(/fail/i)).not.toBeInTheDocument();
      });
    });
  });
});
