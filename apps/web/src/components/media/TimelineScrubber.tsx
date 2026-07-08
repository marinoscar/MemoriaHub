/**
 * TimelineScrubber — Immich-style year/month timeline rail pinned to the right
 * edge of the window. Scrubbing jumps the WINDOW scroll (the media gallery
 * scrolls with the document under a fixed 64px app bar) to the first day-group
 * of the targeted month. As the user scrolls normally, the active-month pill
 * and handle follow the top-most visible day-group.
 *
 * Scroll parent is the WINDOW — all math uses window.scrollY / window.scrollTo /
 * getBoundingClientRect(), never a container ref.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

// Mirror MediaGallery's fixed app-bar offset.
const APP_BAR_HEIGHT = 64;

// Cap best-effort feed auto-loads when scrubbing to a not-yet-loaded month.
const MAX_AUTO_LOADS = 20;

export interface TimelineScrubberProps {
  /** Day-groups from groupByDay — newest first, may include an 'undated' group. */
  groups: Array<{ key: string; label: string; items: unknown[] }>;
  /** Resolve a day-group's scroll target element by its group key (YYYY-MM-DD or 'undated'). */
  getGroupElement: (key: string) => HTMLElement | null;
  /** Feed mode: request the next page be loaded (for scrubbing to not-yet-loaded months). */
  onRequestLoadMore?: () => void;
  /** Whether more pages exist to load. */
  hasMore?: boolean;
}

interface MonthBucket {
  /** 'YYYY-MM' or 'undated'. */
  id: string;
  /** Display label e.g. "Mar 2025" or "Undated". */
  label: string;
  /** Group key of the newest day-group in this month (scroll target). */
  firstDayKey: string;
  /** Year parsed from id (NaN for 'undated'). */
  year: number;
}

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Reduce per-day groups into ordered, unique month buckets (newest first). */
function buildBuckets(
  groups: Array<{ key: string; label: string; items: unknown[] }>,
): MonthBucket[] {
  const buckets: MonthBucket[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    if (group.key === 'undated') {
      if (!seen.has('undated')) {
        seen.add('undated');
        buckets.push({
          id: 'undated',
          label: 'Undated',
          firstDayKey: group.key,
          year: Number.NaN,
        });
      }
      continue;
    }

    const match = DAY_KEY_RE.exec(group.key);
    if (!match) continue;

    const monthId = group.key.slice(0, 7); // 'YYYY-MM'
    if (seen.has(monthId)) continue;
    seen.add(monthId);

    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const label = new Date(year, monthIndex, 1).toLocaleDateString(undefined, {
      month: 'short',
      year: 'numeric',
    });

    buckets.push({ id: monthId, label, firstDayKey: group.key, year });
  }

  return buckets;
}

export function TimelineScrubber({
  groups,
  getGroupElement,
  onRequestLoadMore,
  hasMore = false,
}: TimelineScrubberProps) {
  const theme = useTheme();

  const buckets = useMemo(() => buildBuckets(groups), [groups]);

  const railRef = useRef<HTMLDivElement>(null);

  // Index of the active bucket (drives handle position + pill label).
  const [activeIndex, setActiveIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);

  // Pending target month awaiting more feed pages to load.
  const pendingTargetRef = useRef<string | null>(null);
  const autoLoadCountRef = useRef(0);

  // Keep latest getGroupElement in a ref so scroll handler stays stable.
  const getGroupElementRef = useRef(getGroupElement);
  getGroupElementRef.current = getGroupElement;

  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const bucketsRef = useRef(buckets);
  bucketsRef.current = buckets;

  // -------------------------------------------------------------------------
  // Jump to a bucket's first day-group (single scrollTo to avoid a two-step jump)
  // -------------------------------------------------------------------------

  const jumpToBucket = useCallback((bucket: MonthBucket) => {
    const el = getGroupElementRef.current(bucket.firstDayKey);
    if (!el) return false;
    const top = window.scrollY + el.getBoundingClientRect().top - APP_BAR_HEIGHT;
    window.scrollTo(0, Math.max(0, top));
    return true;
  }, []);

  // -------------------------------------------------------------------------
  // Resolve a bucket index → jump, or queue a feed auto-load if not present yet
  // -------------------------------------------------------------------------

  const goToIndex = useCallback(
    (index: number) => {
      const list = bucketsRef.current;
      if (list.length === 0) return;
      const clamped = Math.max(0, Math.min(list.length - 1, index));
      const bucket = list[clamped];
      setActiveIndex(clamped);

      const jumped = jumpToBucket(bucket);
      if (!jumped && hasMore && onRequestLoadMore) {
        // Target month not loaded yet — kick off bounded best-effort loading.
        pendingTargetRef.current = bucket.id;
        if (autoLoadCountRef.current < MAX_AUTO_LOADS) {
          autoLoadCountRef.current += 1;
          onRequestLoadMore();
        }
      } else {
        pendingTargetRef.current = null;
      }
    },
    [jumpToBucket, hasMore, onRequestLoadMore],
  );

  // -------------------------------------------------------------------------
  // Feed auto-load loop: react to groups/buckets changes (no busy loop)
  // -------------------------------------------------------------------------

  useEffect(() => {
    const targetId = pendingTargetRef.current;
    if (!targetId) return;

    const bucket = buckets.find((b) => b.id === targetId);
    if (bucket) {
      // Target month now exists — perform the jump and clear the pending state.
      pendingTargetRef.current = null;
      autoLoadCountRef.current = 0;
      const idx = buckets.indexOf(bucket);
      setActiveIndex(idx);
      jumpToBucket(bucket);
      return;
    }

    // Still missing — request the next page if we can, else give up gracefully.
    if (hasMore && onRequestLoadMore && autoLoadCountRef.current < MAX_AUTO_LOADS) {
      autoLoadCountRef.current += 1;
      onRequestLoadMore();
    } else if (!hasMore || autoLoadCountRef.current >= MAX_AUTO_LOADS) {
      pendingTargetRef.current = null;
      autoLoadCountRef.current = 0;
    }
  }, [buckets, hasMore, onRequestLoadMore, jumpToBucket]);

  // -------------------------------------------------------------------------
  // Active-month tracking via rAF-throttled window scroll listener
  // -------------------------------------------------------------------------

  useEffect(() => {
    let frame = 0;

    const recompute = () => {
      frame = 0;
      const list = groupsRef.current;
      const bkts = bucketsRef.current;
      if (list.length === 0 || bkts.length === 0) return;

      const epsilon = 4;
      let activeKey = list[0]?.key ?? null;

      // The active day-group is the last one whose header sits at/under the app bar.
      for (const group of list) {
        const el = getGroupElementRef.current(group.key);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        if (top <= APP_BAR_HEIGHT + epsilon) {
          activeKey = group.key;
        } else {
          break;
        }
      }

      if (!activeKey) return;
      const monthId = activeKey === 'undated' ? 'undated' : activeKey.slice(0, 7);
      const idx = bkts.findIndex((b) => b.id === monthId);
      if (idx >= 0) {
        setActiveIndex((prev) => (prev === idx ? prev : idx));
      }
    };

    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(recompute);
    };

    // Initial sync + on every groups change.
    recompute();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [groups]);

  // -------------------------------------------------------------------------
  // Pointer interaction: map a Y within the rail to the nearest bucket index
  // -------------------------------------------------------------------------

  const indexFromClientY = useCallback((clientY: number): number => {
    const rail = railRef.current;
    const list = bucketsRef.current;
    if (!rail || list.length === 0) return 0;
    const rect = rail.getBoundingClientRect();
    const ratio = (clientY - rect.top) / Math.max(1, rect.height);
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    return Math.round(clampedRatio * (list.length - 1));
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      railRef.current?.setPointerCapture(e.pointerId);
      setDragging(true);
      goToIndex(indexFromClientY(e.clientY));
    },
    [goToIndex, indexFromClientY],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      e.preventDefault();
      const idx = indexFromClientY(e.clientY);
      setActiveIndex((prev) => {
        if (prev === idx) return prev;
        goToIndex(idx);
        return idx;
      });
    },
    [dragging, goToIndex, indexFromClientY],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      e.preventDefault();
      if (railRef.current?.hasPointerCapture(e.pointerId)) {
        railRef.current.releasePointerCapture(e.pointerId);
      }
      setDragging(false);
    },
    [dragging],
  );

  // -------------------------------------------------------------------------
  // Keyboard support
  // -------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const list = bucketsRef.current;
      if (list.length === 0) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          goToIndex(activeIndex + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          goToIndex(activeIndex - 1);
          break;
        case 'Home':
          e.preventDefault();
          goToIndex(0);
          break;
        case 'End':
          e.preventDefault();
          goToIndex(list.length - 1);
          break;
        default:
          break;
      }
    },
    [activeIndex, goToIndex],
  );

  // -------------------------------------------------------------------------
  // Nothing to scrub when there are <2 month buckets.
  // -------------------------------------------------------------------------

  if (buckets.length < 2) return null;

  const activeBucket = buckets[Math.min(activeIndex, buckets.length - 1)];
  const handleRatio = buckets.length > 1 ? activeIndex / (buckets.length - 1) : 0;
  const pillVisible = dragging || hovering;

  // Label a subset of ticks — year boundaries — to avoid clutter.
  let lastLabeledYear: number | null = null;

  return (
    <Box
      ref={railRef}
      role="slider"
      aria-label="Timeline"
      aria-valuemin={0}
      aria-valuemax={buckets.length - 1}
      aria-valuenow={activeIndex}
      aria-valuetext={activeBucket?.label}
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      sx={{
        position: 'fixed',
        top: APP_BAR_HEIGHT,
        right: 0,
        bottom: 0,
        width: 44,
        zIndex: theme.zIndex.appBar - 1,
        cursor: 'pointer',
        touchAction: 'none',
        userSelect: 'none',
        outline: 'none',
        display: { xs: 'none', sm: 'block' },
        '&:focus-visible': {
          boxShadow: `inset -2px 0 0 ${theme.palette.primary.main}`,
        },
      }}
    >
      {/* Tick marks */}
      {buckets.map((bucket, i) => {
        const ratio = buckets.length > 1 ? i / (buckets.length - 1) : 0;
        const showYearLabel =
          !Number.isNaN(bucket.year) && bucket.year !== lastLabeledYear;
        if (showYearLabel) lastLabeledYear = bucket.year;
        return (
          <Box
            key={bucket.id}
            sx={{
              position: 'absolute',
              right: 0,
              top: `${ratio * 100}%`,
              transform: 'translateY(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              pointerEvents: 'none',
            }}
          >
            {showYearLabel && (hovering || dragging) && (
              <Typography
                variant="caption"
                sx={{
                  fontSize: '0.6rem',
                  lineHeight: 1,
                  color: theme.palette.text.secondary,
                  whiteSpace: 'nowrap',
                }}
              >
                {bucket.year}
              </Typography>
            )}
            <Box
              sx={{
                width: showYearLabel ? 10 : 6,
                height: 2,
                borderRadius: 1,
                backgroundColor:
                  i === activeIndex
                    ? theme.palette.primary.main
                    : theme.palette.text.disabled,
                opacity: showYearLabel ? 0.9 : 0.5,
              }}
            />
          </Box>
        );
      })}

      {/* Active-month handle / pill */}
      <Box
        sx={{
          position: 'absolute',
          right: 6,
          top: `${handleRatio * 100}%`,
          transform: 'translateY(-50%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          minHeight: 44,
          pointerEvents: 'none',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            px: 1,
            py: 0.5,
            borderRadius: 999,
            backgroundColor: theme.palette.background.paper,
            border: `1px solid ${theme.palette.divider}`,
            boxShadow: theme.shadows[3],
            opacity: pillVisible ? 1 : 0.9,
            transition: 'opacity 0.15s ease',
          }}
        >
          <Typography
            variant="caption"
            sx={{
              fontWeight: 600,
              fontSize: '0.72rem',
              lineHeight: 1,
              color: theme.palette.text.primary,
              whiteSpace: 'nowrap',
            }}
          >
            {activeBucket?.label}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}
