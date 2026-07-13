/**
 * Unit tests — MediaPreviewContext
 *
 * MediaPreviewProvider maintains an in-memory Map<mediaItemId, objectURL>
 * (backed by a ref, not state) so the gallery can show an instant local
 * preview of a just-uploaded photo/video before the server thumbnail is
 * ready. Covers issue #89 (upload tile stuck on "Processing…" until refresh).
 *
 * jsdom does not implement URL.createObjectURL / URL.revokeObjectURL, so
 * both are stubbed with vi.fn() for every test in this file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, render } from '@testing-library/react';
import {
  MediaPreviewProvider,
  useMediaPreview,
} from '../../contexts/MediaPreviewContext';

// ---------------------------------------------------------------------------
// URL.createObjectURL / revokeObjectURL stubs
// ---------------------------------------------------------------------------

let createObjectURLMock: ReturnType<typeof vi.fn>;
let revokeObjectURLMock: ReturnType<typeof vi.fn>;
let urlCounter = 0;

function makeFile(name = 'photo.jpg'): File {
  return new File(['fake-bytes'], name, { type: 'image/jpeg' });
}

beforeEach(() => {
  urlCounter = 0;
  createObjectURLMock = vi.fn(() => `blob:mock-${++urlCounter}`);
  revokeObjectURLMock = vi.fn();
  (global as any).URL.createObjectURL = createObjectURLMock;
  (global as any).URL.revokeObjectURL = revokeObjectURLMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderMediaPreview() {
  return renderHook(() => useMediaPreview(), {
    wrapper: MediaPreviewProvider,
  });
}

describe('MediaPreviewContext', () => {
  describe('addPreview / getPreview', () => {
    it('creates an object URL for the file and stores it under the media item id', () => {
      const { result } = renderMediaPreview();
      const file = makeFile();

      act(() => {
        result.current.addPreview('item-1', file);
      });

      expect(createObjectURLMock).toHaveBeenCalledWith(file);
      expect(result.current.getPreview('item-1')).toBe('blob:mock-1');
    });

    it('returns undefined for an id with no stored preview', () => {
      const { result } = renderMediaPreview();
      expect(result.current.getPreview('missing')).toBeUndefined();
    });

    it('increments version on add so reactive consumers can re-render', () => {
      const { result } = renderMediaPreview();
      const versionBefore = result.current.version;

      act(() => {
        result.current.addPreview('item-1', makeFile());
      });

      expect(result.current.version).toBe(versionBefore + 1);
    });
  });

  describe('removePreview', () => {
    it('revokes the object URL and drops it from the store', () => {
      const { result } = renderMediaPreview();

      act(() => {
        result.current.addPreview('item-1', makeFile());
      });
      const url = result.current.getPreview('item-1');

      act(() => {
        result.current.removePreview('item-1');
      });

      expect(revokeObjectURLMock).toHaveBeenCalledWith(url);
      expect(result.current.getPreview('item-1')).toBeUndefined();
    });

    it('is a no-op when the id has no stored preview', () => {
      const { result } = renderMediaPreview();

      act(() => {
        result.current.removePreview('never-added');
      });

      expect(revokeObjectURLMock).not.toHaveBeenCalled();
    });
  });

  describe('duplicate id handling', () => {
    it('revokes the stale URL before storing the new one when addPreview is called twice for the same id', () => {
      const { result } = renderMediaPreview();

      act(() => {
        result.current.addPreview('item-1', makeFile('first.jpg'));
      });
      const firstUrl = result.current.getPreview('item-1');
      expect(firstUrl).toBe('blob:mock-1');

      act(() => {
        result.current.addPreview('item-1', makeFile('second.jpg'));
      });

      expect(revokeObjectURLMock).toHaveBeenCalledWith(firstUrl);
      expect(result.current.getPreview('item-1')).toBe('blob:mock-2');
    });
  });

  describe('50-entry cap', () => {
    it('evicts the oldest inserted entry (revoking its URL) once the cap is exceeded', () => {
      const { result } = renderMediaPreview();

      act(() => {
        for (let i = 0; i < 50; i++) {
          result.current.addPreview(`item-${i}`, makeFile());
        }
      });

      // At the cap: nothing evicted yet.
      expect(result.current.getPreview('item-0')).toBe('blob:mock-1');
      expect(revokeObjectURLMock).not.toHaveBeenCalled();

      act(() => {
        result.current.addPreview('item-50', makeFile());
      });

      // Oldest (item-0) is evicted and its URL revoked.
      expect(result.current.getPreview('item-0')).toBeUndefined();
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-1');
      // The newest entry is retained.
      expect(result.current.getPreview('item-50')).toBe('blob:mock-51');
      // The rest of the window (item-1..item-49) survives.
      expect(result.current.getPreview('item-1')).toBe('blob:mock-2');
    });
  });

  describe('provider unmount', () => {
    it('revokes every stored object URL when the provider unmounts', () => {
      let addPreview!: (id: string, file: File) => void;

      function Capture() {
        const ctx = useMediaPreview();
        addPreview = ctx.addPreview;
        return null;
      }

      const { unmount } = render(
        <MediaPreviewProvider>
          <Capture />
        </MediaPreviewProvider>,
      );

      act(() => {
        addPreview('item-1', makeFile('a.jpg'));
        addPreview('item-2', makeFile('b.jpg'));
      });

      expect(revokeObjectURLMock).not.toHaveBeenCalled();

      unmount();

      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-1');
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-2');
      expect(revokeObjectURLMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('without a provider (safe no-op defaults)', () => {
    it('getPreview returns undefined and add/removePreview do not throw', () => {
      const { result } = renderHook(() => useMediaPreview());

      expect(result.current.getPreview('anything')).toBeUndefined();
      expect(() => result.current.addPreview('x', makeFile())).not.toThrow();
      expect(() => result.current.removePreview('x')).not.toThrow();
      expect(createObjectURLMock).not.toHaveBeenCalled();
    });
  });
});
