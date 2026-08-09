import { useCallback, useRef, useState } from 'react';
import {
  deleteMemory,
  favoriteMemory,
  hideMemory,
  markMemorySeen,
  unfavoriteMemory,
  unhideMemory,
} from '../services/memories';
import type { MemoryMyState } from '../types/memories';

/**
 * Memories already reported seen in THIS browser session.
 *
 * Module-scoped on purpose. The carousel and the hub both observe the same
 * cards, and a user who scrolls a card into view, opens the hub, and scrolls it
 * into view again would otherwise POST `/seen` twice for a value the server
 * pins to the FIRST view anyway. Deduping here makes the write happen once per
 * memory per session no matter which surface saw it.
 */
const seenThisSession = new Set<string>();

/** Test hook: forget which memories have been reported seen. */
export function resetSeenSession(): void {
  seenThisSession.clear();
}

/**
 * The caller's local list, expressed as the mutations an optimistic update
 * needs. All optional, so a surface holding a single memory (the detail page)
 * can use this hook without inventing a list.
 */
export interface MemoryActionPatchers {
  patchMyState?: (id: string, patch: Partial<MemoryMyState>) => void;
  removeItem?: (id: string) => void;
  restoreItem?: (id: string) => void;
}

export interface UseMemoryActionsResult {
  /** Fire-and-forget; safe to call repeatedly — deduped per session. */
  markSeen: (id: string) => void;
  setFavorite: (id: string, favorited: boolean) => Promise<boolean>;
  setHidden: (id: string, hidden: boolean) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  /** Last action failure, for a snackbar. Cleared on the next attempt. */
  error: string | null;
  clearError: () => void;
}

/**
 * Per-user memory mutations with OPTIMISTIC updates and rollback on failure.
 *
 * Every method flips the caller's local state first, issues the request, and
 * reverts that exact flip if the request throws — so a failed favorite never
 * leaves a heart filled against a server that says otherwise. `markSeen` is the
 * one exception: it is fire-and-forget, because a lost seen write costs nothing
 * beyond an unseen ring that clears on the next view.
 */
export function useMemoryActions(
  patchers: MemoryActionPatchers = {},
): UseMemoryActionsResult {
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so the returned callbacks stay referentially stable even
  // though callers pass a fresh object literal on every render.
  const patchersRef = useRef(patchers);
  patchersRef.current = patchers;

  const markSeen = useCallback((id: string) => {
    if (seenThisSession.has(id)) return;
    seenThisSession.add(id);
    patchersRef.current.patchMyState?.(id, { seen: true });
    void markMemorySeen(id).catch(() => {
      // Allow a retry on the next view rather than never reporting it at all.
      seenThisSession.delete(id);
    });
  }, []);

  const setFavorite = useCallback(async (id: string, favorited: boolean) => {
    setError(null);
    patchersRef.current.patchMyState?.(id, { favorited });
    try {
      await (favorited ? favoriteMemory(id) : unfavoriteMemory(id));
      return true;
    } catch (err) {
      patchersRef.current.patchMyState?.(id, { favorited: !favorited });
      setError(
        err instanceof Error ? err.message : 'Failed to update this memory',
      );
      return false;
    }
  }, []);

  const setHidden = useCallback(async (id: string, hidden: boolean) => {
    setError(null);
    if (hidden) patchersRef.current.removeItem?.(id);
    try {
      await (hidden ? hideMemory(id) : unhideMemory(id));
      return true;
    } catch (err) {
      if (hidden) patchersRef.current.restoreItem?.(id);
      setError(err instanceof Error ? err.message : 'Failed to hide this memory');
      return false;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setError(null);
    patchersRef.current.removeItem?.(id);
    try {
      await deleteMemory(id);
      return true;
    } catch (err) {
      patchersRef.current.restoreItem?.(id);
      setError(
        err instanceof Error ? err.message : 'Failed to delete this memory',
      );
      return false;
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { markSeen, setFavorite, setHidden, remove, error, clearError };
}
