/**
 * ImageUpload — unit tests.
 *
 * The component now posts to the real `POST /api/users/me/avatar` endpoint and
 * hands its caller the FULL refreshed profile the API returns (issue #354),
 * rather than a bare `{ url }` from an endpoint that never existed. fetch is
 * mocked to simulate server responses; the component uses a native file input,
 * so we drive it with userEvent.upload().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { ImageUpload } from '../../../components/settings/ImageUpload';
import type { UserProfile } from '../../../services/userProfile';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeFile(name: string, type: string, sizeBytes: number): File {
  const buf = new Uint8Array(sizeBytes);
  return new File([buf], name, { type });
}

const mockProfile: UserProfile = {
  id: 'test-user-id',
  email: 'test@example.com',
  displayName: 'Test User',
  avatarUrl: '/api/users/test-user-id/avatar?v=ab12cd',
  avatarSource: 'upload',
  providerProfileImageUrl: null,
  linkedPerson: null,
};

/** The API wraps successful payloads in `{ data }` (TransformInterceptor). */
function okResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
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
    it('POSTs to /api/users/me/avatar and returns the refreshed profile', async () => {
      const fetchMock = vi.fn().mockResolvedValue(okResponse({ data: mockProfile }));
      global.fetch = fetchMock;

      const user = userEvent.setup();
      render(<ImageUpload onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, makeFile('avatar.jpg', 'image/jpeg', 1024));

      await waitFor(() => {
        expect(onUpload).toHaveBeenCalledWith(mockProfile);
      });

      // The base URL is env-configurable (VITE_API_BASE_URL), so assert on the
      // path rather than the fully-qualified address.
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toMatch(/\/api\/users\/me\/avatar$/);
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get('file')).toBeInstanceOf(File);
      // The browser must set the multipart boundary itself.
      expect(init.headers['Content-Type']).toBeUndefined();
    });

    it('accepts WebP files', async () => {
      global.fetch = vi.fn().mockResolvedValue(okResponse({ data: mockProfile }));

      const user = userEvent.setup();
      render(<ImageUpload onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, makeFile('photo.webp', 'image/webp', 512));

      await waitFor(() => {
        expect(onUpload).toHaveBeenCalledWith(mockProfile);
      });
    });

    it('accepts HEIC files', async () => {
      global.fetch = vi.fn().mockResolvedValue(okResponse({ data: mockProfile }));

      const user = userEvent.setup();
      render(<ImageUpload onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      const heic = makeFile('photo.heic', 'image/heic', 512);

      // jsdom's userEvent honors `accept`; assert the type passes validation by
      // driving the change event directly.
      Object.defineProperty(input, 'files', { value: [heic], configurable: true });
      const { fireEvent } = await import('@testing-library/react');
      fireEvent.change(input);

      await waitFor(() => {
        expect(onUpload).toHaveBeenCalledWith(mockProfile);
      });
    });
  });

  describe('handleFileSelect — fetch errors', () => {
    it('shows the server error message when the request fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 413,
        json: () => Promise.resolve({ message: 'Image must be under 5MB' }),
      } as Response);

      const user = userEvent.setup();
      render(<ImageUpload onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, makeFile('avatar.jpg', 'image/jpeg', 1024));

      await waitFor(() => {
        const bodyText = document.querySelector('body')!.textContent ?? '';
        expect(bodyText).toMatch(/image must be under 5mb/i);
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
      resolveFetch(okResponse({ data: mockProfile }));
    });
  });
});
