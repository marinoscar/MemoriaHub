/**
 * `user_settings.navigation` — the rail's pin list and its collapse state.
 *
 * Issue #392, epic #388, spec §5. **No new endpoint and no new request
 * pattern**: this reads and writes the same `GET`/`PATCH /api/user-settings`
 * the rest of the app already uses, through the same `useUserSettings` hook,
 * exactly like the `dataTables` / `notifications` / `memories` namespaces.
 *
 * THREE CONTRACTS THIS FILE EXISTS TO HOLD
 * ----------------------------------------
 *
 * 1. **ABSENT MEANS DEFAULT, and a default is never written back.** An absent
 *    namespace, an absent field, or a `pinned` we could not read means
 *    "nothing pinned, rail expanded". We do not PATCH that back on load: the
 *    API deliberately ships this namespace with no `.default()` anywhere so a
 *    later change to the defaults still reaches users who never touched
 *    navigation, and materialising today's defaults into their blob would
 *    silently opt them out of that forever.
 *
 * 2. **ONE SHARED RESOLUTION from key → route + label.** A pinned entry must
 *    never show a different label or point at a different route than the same
 *    entry in the pane it was pinned from (spec §5). That is guaranteed
 *    STRUCTURALLY here rather than by discipline: the pinnable set is DERIVED
 *    from the two hub registries (`config/collections.tsx`,
 *    `config/reviewQueues.tsx`) plus `reviewQueuePath()` — the same three
 *    declarations `CollectionsList` and `ReviewQueueList` render from. Adding
 *    an entry to either registry makes it pinnable automatically; there is no
 *    second list to forget.
 *
 * 3. **A pin whose feature flag is off does not RENDER, but is never
 *    REMOVED.** Turning `features.memories` back on must restore the pin, not
 *    discover it was silently discarded while the flag was down (spec §5).
 *    Filtering therefore happens in `usePinnedDestinations` — the render path —
 *    and never in `sanitizePinned`, which is the storage path.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { SvgIconComponent } from '@mui/icons-material';
import { COLLECTIONS } from '../config/collections';
import type { CollectionKey } from '../config/collections';
import { REVIEW_QUEUES } from '../config/reviewQueues';
import type { ReviewQueueKey } from '../config/reviewQueues';
// Imported, not re-derived: this is the function the Review pane's own rows use
// to build their `to`, so a pinned "Bursts" and the pane's "Bursts" cannot come
// to point at two different routes (contract 2 above).
import { reviewQueuePath } from '../components/review/ReviewQueueList';
import { useUserSettings } from './useUserSettings';
import { useMemoriesEnabled } from './useMemoriesEnabled';
import { useIsMounted } from './useIsMounted';

// ---------------------------------------------------------------------------
// The pinnable set — derived, not declared
// ---------------------------------------------------------------------------

/**
 * The one key that is NOT simply the hub registry's own key.
 *
 * The Review registry calls its analytics entry `insights` (it is the
 * `/review/insights` segment), but the persisted pin key is `review-insights`
 * — `insights` alone would be ambiguous the moment any other hub grows an
 * entry by that name, and the API's `NAVIGATION_PINNABLE_KEYS` is already
 * frozen on the qualified spelling. The two mappers below are the ONLY place
 * that difference exists.
 */
const REVIEW_INSIGHTS_PIN_KEY = 'review-insights' as const;

/**
 * Keys a user may pin. SUB-destinations only, never one of the four primaries
 * — pinning Photos would be meaningless, it is already in the rail (spec §5).
 *
 * This union is exactly the API's `NAVIGATION_PINNABLE_KEYS` (14 entries), but
 * expressed as `CollectionKey ∪ ReviewQueueKey` so the compiler — not a code
 * review — is what notices if a hub registry and this file drift apart.
 */
export type PinnableKey =
  | CollectionKey
  | Exclude<ReviewQueueKey, 'insights'>
  | typeof REVIEW_INSIGHTS_PIN_KEY;

/** Cap mirrored from the API's `NAVIGATION_MAX_PINNED`. Over-cap is a 400 there. */
export const NAVIGATION_MAX_PINNED = 6;

function reviewPinKey(key: ReviewQueueKey): PinnableKey {
  return key === 'insights' ? REVIEW_INSIGHTS_PIN_KEY : key;
}

/** A pinnable entry, fully resolved to everything the rail needs to draw a row. */
export interface PinnableDestination {
  key: PinnableKey;
  label: string;
  path: string;
  Icon: SvgIconComponent;
  /** Which of the four destinations this entry lives inside. */
  parent: 'collections' | 'review';
  /**
   * The registry key this came from, kept so the render path can ask the right
   * feature-flag resolver about it without a second lookup table.
   */
  collectionKey: CollectionKey | null;
  reviewKey: ReviewQueueKey | null;
}

/**
 * Every pinnable destination, in hub order: Collections first, then Review.
 *
 * Derived from the registries, so this list cannot fall out of step with what
 * the two context panes render.
 */
export const PINNABLE_DESTINATIONS: readonly PinnableDestination[] = [
  ...COLLECTIONS.map<PinnableDestination>((entry) => ({
    key: entry.key,
    label: entry.label,
    path: entry.path,
    Icon: entry.Icon,
    parent: 'collections',
    collectionKey: entry.key,
    reviewKey: null,
  })),
  ...REVIEW_QUEUES.map<PinnableDestination>((entry) => ({
    key: reviewPinKey(entry.key),
    label: entry.label,
    path: reviewQueuePath(entry.key),
    Icon: entry.Icon,
    parent: 'review',
    collectionKey: null,
    reviewKey: entry.key,
  })),
];

const PINNABLE_BY_KEY = new Map<string, PinnableDestination>(
  PINNABLE_DESTINATIONS.map((entry) => [entry.key, entry]),
);

/** Is `value` a key this build knows how to render? */
export function isPinnableKey(value: string): value is PinnableKey {
  return PINNABLE_BY_KEY.has(value);
}

/**
 * Normalise a stored `pinned` array for use.
 *
 * **Unknown keys are DROPPED, never thrown on.** A stored key this build does
 * not recognise is not a client bug — it is our own past self: a destination a
 * previous release shipped, the user pinned, and a later release removed.
 * Degrading it to "not pinned" is the only acceptable behaviour; anything that
 * threw would take the whole rail down over one dead pin.
 *
 * Duplicates are collapsed and the list is capped, so a blob written by some
 * other client can never make the rail render two identical rows or seven pins.
 */
function sanitizePinned(raw: unknown): PinnableKey[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PinnableKey[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    if (!isPinnableKey(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= NAVIGATION_MAX_PINNED) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

interface NavigationState {
  pinned: PinnableKey[];
  railCollapsed: boolean;
}

export interface UseNavigationPrefsResult {
  /** Stored pin order, sanitised. NOT feature-filtered — see `usePinnedDestinations`. */
  pinned: PinnableKey[];
  /** Desktop rail collapse preference. Absent ⇒ `false` ⇒ expanded. */
  railCollapsed: boolean;
  toggleRailCollapsed: () => void;
  pin: (key: PinnableKey) => void;
  unpin: (key: PinnableKey) => void;
  isPinned: (key: PinnableKey) => boolean;
  /**
   * Room for one more pin. The cap is enforced client-side as well as by the
   * API so the user gets a DISABLED affordance rather than a 400 after the
   * click — the API's cap is the correctness backstop, this one is the UX.
   */
  canPin: boolean;
  /** True until the first settings read resolves; the rail renders defaults meanwhile. */
  isLoading: boolean;
}

export function useNavigationPrefs(): UseNavigationPrefsResult {
  // `syncTheme: false` — this hook is mounted by the always-present navigation
  // rail, and it is here for the `navigation` namespace only. Left on, it would
  // quietly make the STORED theme authoritative on every page load and stamp
  // over the AppBar's local light/dark toggle on the next reload.
  const { settings, isLoading, updateSettings } = useUserSettings({ syncTheme: false });
  const isMounted = useIsMounted();

  // What the server currently says. Absent anywhere in the chain collapses to
  // the built-in defaults, and nothing is written back to make them explicit.
  const stored = useMemo<NavigationState>(
    () => ({
      pinned: sanitizePinned(settings?.navigation?.pinned),
      // `=== true`, never truthy: absent must be indistinguishable from an
      // explicit `false` at the READ side, and both mean "expanded".
      railCollapsed: settings?.navigation?.railCollapsed === true,
    }),
    [settings],
  );

  // Optimistic overlay. The collapse toggle in particular must feel instant —
  // waiting a round trip to animate a 220px column is the kind of lag users
  // read as a broken button. Cleared once the write settles, at which point
  // `stored` either carries the new value (success) or still carries the old
  // one (failure), so the revert is the same code path as the commit.
  const [overlay, setOverlay] = useState<NavigationState | null>(null);
  // Guards against a late write from a previous click clearing a newer overlay.
  const writeSeq = useRef(0);

  const effective = overlay ?? stored;

  const write = useCallback(
    (next: NavigationState, patch: { pinned?: PinnableKey[]; railCollapsed?: boolean }) => {
      // No settings yet means no `version` for the If-Match header, so
      // `updateSettings` would no-op. Skipping the overlay too keeps the UI
      // honest rather than showing a change that was never sent.
      if (!settings) return;

      const seq = ++writeSeq.current;
      setOverlay(next);

      // Only the `navigation` namespace goes on the wire, and inside it only
      // the field that changed — PATCH merges field-wise, so a concurrent
      // change to the OTHER field (another tab collapsing the rail while this
      // one pins something) is preserved rather than clobbered.
      void updateSettings({ navigation: patch })
        .catch(() => undefined)
        .finally(() => {
          if (!isMounted()) return;
          if (writeSeq.current !== seq) return;
          setOverlay(null);
        });
    },
    [settings, updateSettings, isMounted],
  );

  const toggleRailCollapsed = useCallback(() => {
    const railCollapsed = !effective.railCollapsed;
    write({ ...effective, railCollapsed }, { railCollapsed });
  }, [effective, write]);

  const pin = useCallback(
    (key: PinnableKey) => {
      if (effective.pinned.includes(key)) return;
      if (effective.pinned.length >= NAVIGATION_MAX_PINNED) return;
      const pinned = [...effective.pinned, key];
      write({ ...effective, pinned }, { pinned });
    },
    [effective, write],
  );

  const unpin = useCallback(
    (key: PinnableKey) => {
      if (!effective.pinned.includes(key)) return;
      const pinned = effective.pinned.filter((entry) => entry !== key);
      write({ ...effective, pinned }, { pinned });
    },
    [effective, write],
  );

  const isPinned = useCallback(
    (key: PinnableKey) => effective.pinned.includes(key),
    [effective],
  );

  return {
    pinned: effective.pinned,
    railCollapsed: effective.railCollapsed,
    toggleRailCollapsed,
    pin,
    unpin,
    isPinned,
    canPin: effective.pinned.length < NAVIGATION_MAX_PINNED,
    isLoading,
  };
}

// ---------------------------------------------------------------------------
// Render-time resolution
// ---------------------------------------------------------------------------

/**
 * Resolve stored pin keys to renderable rows, dropping entries whose feature is
 * off.
 *
 * BOTH inputs are ARGUMENTS rather than hook calls made in here, and both for
 * the same reason — this runs alongside the rail, which already has them:
 *
 *   - calling `useNavigationPrefs()` here would mount a SECOND
 *     `useUserSettings` (a duplicate GET, and a second optimistic overlay that
 *     could not see the first one's toggle);
 *   - calling `useReviewQueues()` here would mount a SECOND `useReviewCounts`,
 *     which by that hook's own explicit design is NOT deduplicated — two
 *     mounted consumers means two `GET /api/media/review-counts` requests on
 *     every refresh signal.
 *
 * The Collections half is gated by `useMemoriesEnabled`, which the rail does
 * NOT already hold — but that one is a module-level flags cache shared with
 * `useCollectionSummaries` and issues no request of its own, so mounting it
 * here is free. `=== true` throughout, never a truthy check: a flag still in
 * flight, or a flags outage that resolves to null, must HIDE the entry rather
 * than guess it on.
 */
export function usePinnedDestinations(
  pinned: PinnableKey[],
  /** The caller's already-resolved enabled Review entries — see above. */
  reviewEntries: readonly { key: ReviewQueueKey }[],
): PinnableDestination[] {
  const memoriesEnabled = useMemoriesEnabled();

  const enabledReviewKeys = useMemo(
    () => new Set<ReviewQueueKey>(reviewEntries.map((entry) => entry.key)),
    [reviewEntries],
  );

  return useMemo(() => {
    const out: PinnableDestination[] = [];
    for (const key of pinned) {
      const entry = PINNABLE_BY_KEY.get(key);
      if (!entry) continue;
      if (entry.reviewKey !== null && !enabledReviewKeys.has(entry.reviewKey)) continue;
      // The only flag-gated collection today (`flag: 'memories'` in the
      // registry). Read through the same hook the hub uses so the pin and the
      // pane can never disagree about whether Memories exists.
      if (entry.collectionKey === 'memories' && memoriesEnabled !== true) continue;
      out.push(entry);
    }
    return out;
  }, [pinned, enabledReviewKeys, memoriesEnabled]);
}
