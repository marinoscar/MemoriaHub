/**
 * Component tests — MediaUploadDialog
 *
 * Mocking strategy:
 *   The media service functions used inside MediaUploadDialog
 *   (initUpload, uploadPart, completeUpload, registerMedia, listMedia) are all
 *   module-level mocks via vi.mock('../../services/media').  No real
 *   fetch or presigned-URL PUT is made.
 *
 *   sha256File is mocked via vi.mock('../../utils/sha256') so that hashing
 *   does not depend on WebAssembly being available in jsdom. Tests can
 *   control the returned hash value or simulate a hash failure.
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
  listMedia: vi.fn(),
}));

import {
  initUpload,
  uploadPart,
  completeUpload,
  registerMedia,
  listMedia,
} from '../../../services/media';

const mockInitUpload = vi.mocked(initUpload);
const mockUploadPart = vi.mocked(uploadPart);
const mockCompleteUpload = vi.mocked(completeUpload);
const mockRegisterMedia = vi.mocked(registerMedia);
const mockListMedia = vi.mocked(listMedia);

// ---------------------------------------------------------------------------
// Mock sha256File
// ---------------------------------------------------------------------------

vi.mock('../../../utils/sha256', () => ({
  sha256File: vi.fn(),
}));

import { sha256File } from '../../../utils/sha256';
const mockSha256File = vi.mocked(sha256File);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OBJECT_ID = 'test-object-id';
const FAKE_HASH = 'a'.repeat(64); // 64 lower-case hex chars

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

/** Empty listMedia response — no existing items. */
function emptyListResponse() {
  return { items: [], meta: { page: 1, pageSize: 1, totalItems: 0, totalPages: 0 } };
}

/** ListMedia response with one existing item (dedup hit). */
function hitListResponse() {
  return {
    items: [{ id: 'existing-media-id' }],
    meta: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 },
  };
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
    mockRegisterMedia.mockResolvedValue({ id: 'media-001', deduplicated: false } as any);
    mockListMedia.mockResolvedValue(emptyListResponse() as any);
    mockSha256File.mockResolvedValue(FAKE_HASH);
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
      expect(screen.queryByRole('button', { name: /upload \d+ file/i })).not.toBeInTheDocument();
    });

    it('should not render when open=false', () => {
      render(<MediaUploadDialog {...defaultProps} open={false} />);
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

    it('should call registerMedia with contentHash after completeUpload', async () => {
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
          contentHash: FAKE_HASH,
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
        // Summary includes "1 uploaded"
        expect(screen.getByText(/1 uploaded/i)).toBeInTheDocument();
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
        const closeButtons = screen.getAllByRole('button', { name: /close/i });
        const dialogCloseBtn = closeButtons.find(
          (b) => b.tagName === 'BUTTON' && !b.getAttribute('aria-label'),
        );
        expect(dialogCloseBtn).toBeDefined();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Deduplication — pre-check hit (listMedia returns ≥1 item)
  // -------------------------------------------------------------------------

  describe('deduplication — pre-check hit', () => {
    it('should NOT call initUpload when the pre-check finds an existing file', async () => {
      mockListMedia.mockResolvedValue(hitListResponse() as any);

      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('dup.jpg')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      // Both the per-file secondary label and the summary Alert contain "Already in library".
      // Wait until at least one is present before asserting the service mocks.
      await waitFor(() => {
        expect(screen.getAllByText(/already in library/i).length).toBeGreaterThan(0);
      });

      expect(mockInitUpload).not.toHaveBeenCalled();
      expect(mockUploadPart).not.toHaveBeenCalled();
      expect(mockCompleteUpload).not.toHaveBeenCalled();
      expect(mockRegisterMedia).not.toHaveBeenCalled();
    });

    it('should mark the file as duplicate and show the "Already in library" label', async () => {
      mockListMedia.mockResolvedValue(hitListResponse() as any);

      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('dup.jpg')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      // The per-file secondary text reads "Already in library" (exact case)
      await waitFor(() => {
        expect(screen.getAllByText(/already in library/i).length).toBeGreaterThan(0);
      });
    });

    it('should include duplicate count in end-of-run summary', async () => {
      mockListMedia.mockResolvedValue(hitListResponse() as any);

      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('dup.jpg')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      // Summary should mention "1 already in library"
      await waitFor(() => {
        expect(screen.getByText(/1 already in library/i)).toBeInTheDocument();
      });
    });

    it('should call listMedia with the contentHash from sha256File', async () => {
      mockListMedia.mockResolvedValue(emptyListResponse() as any);

      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile()] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => expect(mockListMedia).toHaveBeenCalledTimes(1));
      expect(mockListMedia).toHaveBeenCalledWith(
        expect.objectContaining({ contentHash: FAKE_HASH, pageSize: 1 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Deduplication — server-side race (registerMedia returns deduplicated:true)
  // -------------------------------------------------------------------------

  describe('deduplication — server-side race', () => {
    it('should mark the file as duplicate when registerMedia returns deduplicated:true', async () => {
      // Pre-check misses (empty list), but server deduplicates on register
      mockListMedia.mockResolvedValue(emptyListResponse() as any);
      mockRegisterMedia.mockResolvedValue({ id: 'existing-001', deduplicated: true } as any);

      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('race.jpg')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => {
        expect(screen.getAllByText(/already in library/i).length).toBeGreaterThan(0);
      });
    });

    it('should include the server-deduped file in the duplicate count', async () => {
      mockListMedia.mockResolvedValue(emptyListResponse() as any);
      mockRegisterMedia.mockResolvedValue({ id: 'existing-001', deduplicated: true } as any);

      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('race.jpg')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => {
        expect(screen.getByText(/1 already in library/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Hashing fallback — sha256File throws
  // -------------------------------------------------------------------------

  describe('hashing fallback', () => {
    it('should still upload when sha256File throws (no hash sent)', async () => {
      // Simulate a WebAssembly / hash-wasm failure
      mockSha256File.mockRejectedValue(new Error('WASM init failed'));

      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('fallback.jpg')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => expect(mockRegisterMedia).toHaveBeenCalledTimes(1));

      // listMedia should NOT have been called (no hash available)
      expect(mockListMedia).not.toHaveBeenCalled();

      // registerMedia should have been called WITHOUT contentHash
      expect(mockRegisterMedia).toHaveBeenCalledWith(
        expect.not.objectContaining({ contentHash: expect.anything() }),
      );
    });

    it('should show success after fallback upload completes', async () => {
      mockSha256File.mockRejectedValue(new Error('WASM init failed'));

      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, { target: { files: [makeImageFile('fallback.jpg')] } });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload \d+ file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload \d+ file/i }));

      await waitFor(() => {
        expect(screen.getByText(/1 uploaded/i)).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Mixed batch: one fresh + one duplicate
  // -------------------------------------------------------------------------

  describe('mixed batch', () => {
    it('should show correct counts for a batch with one fresh and one duplicate', async () => {
      // First call (for fresh.jpg): no match → upload proceeds
      // Second call (for dup.jpg): match → skip upload
      mockListMedia
        .mockResolvedValueOnce(emptyListResponse() as any)
        .mockResolvedValueOnce(hitListResponse() as any);
      mockRegisterMedia.mockResolvedValue({ id: 'media-001', deduplicated: false } as any);

      const user = userEvent.setup();
      render(<MediaUploadDialog {...defaultProps} />);
      const input = getFileInput();
      fireEvent.change(input, {
        target: { files: [makeImageFile('fresh.jpg'), makeImageFile('dup.jpg')] },
      });

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /upload 2 file/i })).toBeInTheDocument(),
      );
      await user.click(screen.getByRole('button', { name: /upload 2 file/i }));

      await waitFor(() => {
        // Summary: "1 uploaded, 1 already in library"
        expect(screen.getByText(/1 uploaded/i)).toBeInTheDocument();
        expect(screen.getByText(/1 already in library/i)).toBeInTheDocument();
      });

      // Only one initUpload (the fresh file)
      expect(mockInitUpload).toHaveBeenCalledTimes(1);
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

      await user.click(
        screen.getByRole('button', { name: /retry uploading retry.jpg/i }),
      );

      await waitFor(() => {
        expect(screen.queryByText(/fail/i)).not.toBeInTheDocument();
      });
    });
  });
});
