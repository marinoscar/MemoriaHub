/**
 * ImageUpload — unit tests.
 *
 * Tests the profile image upload component. fetch is mocked to simulate
 * server responses. The component uses native file input, so we use
 * userEvent.upload() to simulate file selection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { ImageUpload } from '../../../components/settings/ImageUpload';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeFile(name: string, type: string, sizeBytes: number): File {
  const buf = new Uint8Array(sizeBytes);
  return new File([buf], name, { type });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ImageUpload', () => {
  let originalFetch: typeof global.fetch;
  const onUpload = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('Rendering', () => {
    it('renders "Upload Custom Image" button', () => {
      render(<ImageUpload onUpload={onUpload} />);
      expect(screen.getByRole('button', { name: /upload custom image/i })).toBeInTheDocument();
    });

    it('button is disabled when disabled=true', () => {
      render(<ImageUpload onUpload={onUpload} disabled />);
      expect(screen.getByRole('button', { name: /upload custom image/i })).toBeDisabled();
    });

    it('does not show error text initially', () => {
      render(<ImageUpload onUpload={onUpload} />);
      // No error element visible at start
      expect(screen.queryByText(/please select/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/file size/i)).not.toBeInTheDocument();
    });
  });

  describe('handleFileSelect — validation errors', () => {
    it('shows error when file type is invalid', async () => {
      render(<ImageUpload onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      const badFile = makeFile('photo.bmp', 'image/bmp', 1024);

      // userEvent.upload respects the `accept` attribute and filters unsupported types.
      // Use fireEvent.change directly to bypass that filter and reach handleFileSelect.
      Object.defineProperty(input, 'files', { value: [badFile], configurable: true });
      const { fireEvent } = await import('@testing-library/react');
      fireEvent.change(input);

      await waitFor(() => {
        const bodyText = document.querySelector('body')!.textContent ?? '';
        expect(bodyText).toMatch(/valid image file/i);
      });
      expect(onUpload).not.toHaveBeenCalled();
    });

    it('shows error when file exceeds 5 MB', async () => {
      const user = userEvent.setup();
      render(<ImageUpload onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, makeFile('large.jpg', 'image/jpeg', 6 * 1024 * 1024));

      await waitFor(() => {
        const bodyText = document.querySelector('body')!.textContent ?? '';
        expect(bodyText).toMatch(/file size must be less than 5mb/i);
      });
      expect(onUpload).not.toHaveBeenCalled();
    });
  });

  describe('handleFileSelect — successful upload', () => {
    it('calls onUpload with the URL returned by the server', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ url: 'https://example.com/avatar.jpg' }),
      } as Response);

      const user = userEvent.setup();
      render(<ImageUpload onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, makeFile('avatar.jpg', 'image/jpeg', 1024));

      await waitFor(() => {
        expect(onUpload).toHaveBeenCalledWith('https://example.com/avatar.jpg');
      });
    });

    it('accepts WebP files', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ url: 'https://example.com/avatar.webp' }),
      } as Response);

      const user = userEvent.setup();
      render(<ImageUpload onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, makeFile('photo.webp', 'image/webp', 512));

      await waitFor(() => {
        expect(onUpload).toHaveBeenCalledWith('https://example.com/avatar.webp');
      });
    });
  });

  describe('handleFileSelect — fetch errors', () => {
    it('shows error when server returns non-ok status', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 413,
      } as Response);

      const user = userEvent.setup();
      render(<ImageUpload onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, makeFile('avatar.jpg', 'image/jpeg', 1024));

      await waitFor(() => {
        const bodyText = document.querySelector('body')!.textContent ?? '';
        expect(bodyText).toMatch(/upload failed/i);
      });
      expect(onUpload).not.toHaveBeenCalled();
    });

    it('shows error when fetch rejects (network error)', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const user = userEvent.setup();
      render(<ImageUpload onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, makeFile('avatar.jpg', 'image/jpeg', 1024));

      await waitFor(() => {
        const bodyText = document.querySelector('body')!.textContent ?? '';
        expect(bodyText).toMatch(/network error/i);
      });
    });

    it('shows Uploading… button while upload is in progress', async () => {
      let resolveFetch!: (val: unknown) => void;
      global.fetch = vi.fn(
        () => new Promise((res) => { resolveFetch = res; }),
      );

      const user = userEvent.setup();
      render(<ImageUpload onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, makeFile('avatar.jpg', 'image/jpeg', 1024));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /uploading/i })).toBeInTheDocument();
      });

      // resolve so the component can clean up
      resolveFetch({ ok: true, json: () => Promise.resolve({ url: 'https://example.com/x.jpg' }) });
    });
  });
});
