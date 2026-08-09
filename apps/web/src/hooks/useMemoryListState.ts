import { useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { MemoryCard, MemoryMyState } from '../types/memories';

/**
 * The three local mutations an optimistic memory action needs, shared by the
 * carousel feed (`useMemoriesFeed`) and the hub list (`useMemories`).
 *
 * `patchMyState` MERGES into the card's existing `myState` rather than
 * replacing it — favoriting a card must not silently clear its `seen` flag, and
 * a whole-object patch is exactly how that bug happens.
 *
 * `removeItem` remembers the card and its index so `restoreItem` can put it
 * back where it was when the server rejects the write. Rolling a hide back to
 * the END of the list would look like a different (and wrong) outcome to the
 * user, so position is part of the rollback, not an afterthought.
 */
export interface MemoryListMutators<T extends MemoryCard> {
  patchMyState: (id: string, patch: Partial<MemoryMyState>) => void;
  removeItem: (id: string) => void;
  restoreItem: (id: string) => void;
  /** Forget any pending rollback snapshots (called on reset/refetch). */
  clearRemoved: () => void;
  /** Exposed for tests and for surfaces that replace the list wholesale. */
  setItems: Dispatch<SetStateAction<T[]>>;
}

export function useMemoryListState<T extends MemoryCard>(
  setItems: Dispatch<SetStateAction<T[]>>,
): MemoryListMutators<T> {
  // id -> { index, item } snapshots for cards removed optimistically.
  const removedRef = useRef(new Map<string, { index: number; item: T }>());

  const patchMyState = useCallback(
    (id: string, patch: Partial<MemoryMyState>) => {
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? ({ ...item, myState: { ...item.myState, ...patch } } as T)
            : item,
        ),
      );
    },
    [setItems],
  );

  const removeItem = useCallback(
    (id: string) => {
      setItems((prev) => {
        const index = prev.findIndex((item) => item.id === id);
        if (index === -1) return prev;
        removedRef.current.set(id, { index, item: prev[index] });
        return prev.filter((item) => item.id !== id);
      });
    },
    [setItems],
  );

  const restoreItem = useCallback(
    (id: string) => {
      const snapshot = removedRef.current.get(id);
      if (!snapshot) return;
      removedRef.current.delete(id);
      setItems((prev) => {
        if (prev.some((item) => item.id === id)) return prev;
        const next = [...prev];
        next.splice(Math.min(snapshot.index, next.length), 0, snapshot.item);
        return next;
      });
    },
    [setItems],
  );

  const clearRemoved = useCallback(() => {
    removedRef.current.clear();
  }, []);

  return { patchMyState, removeItem, restoreItem, clearRemoved, setItems };
}
