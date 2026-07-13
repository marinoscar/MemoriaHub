import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from 'react';

/**
 * MediaPreviewContext — an in-memory object-URL store keyed by media item id.
 *
 * When a photo is uploaded from the browser we already hold its `File` bytes,
 * so we can create an object URL and show it instantly as the gallery tile
 * while the server-side thumbnail is still being generated. A light background
 * reconcile (see `usePendingThumbnails`) then swaps in the optimized server
 * thumbnail and calls `removePreview` to free the blob.
 *
 * Object URLs are stored in a ref (not state) so adding a preview does not
 * force a re-render of every gallery tile. A small `version` counter is
 * exposed for consumers that DO want to react to add/remove.
 */

/** Maximum number of live object URLs retained; oldest inserted are evicted. */
const MAX_PREVIEWS = 50;

interface MediaPreviewContextValue {
  /** Create + store an object URL for `file`, keyed by `mediaItemId`. */
  addPreview: (mediaItemId: string, file: File) => void;
  /** Return the stored object URL for `mediaItemId`, or undefined. */
  getPreview: (mediaItemId: string) => string | undefined;
  /** Revoke + delete the stored object URL for `mediaItemId`. */
  removePreview: (mediaItemId: string) => void;
  /** Increments on every add/remove — for consumers that want reactivity. */
  version: number;
}

const defaultValue: MediaPreviewContextValue = {
  addPreview: () => {},
  getPreview: () => undefined,
  removePreview: () => {},
  version: 0,
};

export const MediaPreviewContext =
  createContext<MediaPreviewContextValue>(defaultValue);

interface MediaPreviewProviderProps {
  children: ReactNode;
}

export function MediaPreviewProvider({ children }: MediaPreviewProviderProps) {
  // id → objectURL. Map preserves insertion order, so the first key is the
  // oldest inserted entry (used for cap eviction).
  const previewsRef = useRef<Map<string, string>>(new Map());
  const [version, setVersion] = useState(0);

  const addPreview = useCallback((mediaItemId: string, file: File) => {
    const map = previewsRef.current;

    // Replace any existing entry for this id (revoke the stale URL first).
    const existing = map.get(mediaItemId);
    if (existing) {
      URL.revokeObjectURL(existing);
      map.delete(mediaItemId);
    }

    const url = URL.createObjectURL(file);
    map.set(mediaItemId, url);

    // Enforce the cap: evict oldest inserted entries beyond MAX_PREVIEWS.
    while (map.size > MAX_PREVIEWS) {
      const oldestKey = map.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldestUrl = map.get(oldestKey);
      if (oldestUrl) URL.revokeObjectURL(oldestUrl);
      map.delete(oldestKey);
    }

    setVersion((v) => v + 1);
  }, []);

  const getPreview = useCallback(
    (mediaItemId: string): string | undefined =>
      previewsRef.current.get(mediaItemId),
    [],
  );

  const removePreview = useCallback((mediaItemId: string) => {
    const map = previewsRef.current;
    const url = map.get(mediaItemId);
    if (url) {
      URL.revokeObjectURL(url);
      map.delete(mediaItemId);
      setVersion((v) => v + 1);
    }
  }, []);

  // Revoke every stored URL when the provider unmounts.
  useEffect(() => {
    const map = previewsRef.current;
    return () => {
      for (const url of map.values()) {
        URL.revokeObjectURL(url);
      }
      map.clear();
    };
  }, []);

  return (
    <MediaPreviewContext.Provider
      value={{ addPreview, getPreview, removePreview, version }}
    >
      {children}
    </MediaPreviewContext.Provider>
  );
}

export function useMediaPreview(): MediaPreviewContextValue {
  return useContext(MediaPreviewContext);
}
