import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, IconButton, Stack, Typography, useMediaQuery, useTheme } from '@mui/material';
import {
  AutoAwesomeMotion as AutoAwesomeMotionIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
} from '@mui/icons-material';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { useMemoriesEnabled } from '../../hooks/useMemoriesEnabled';
import { useMemoriesFeed } from '../../hooks/useMemoriesFeed';
import { useMemoryActions } from '../../hooks/useMemoryActions';
import { MemoryCard, MemoryCardSkeleton } from './MemoryCard';
import type { MemoryCard as MemoryCardDto } from '../../types/memories';

interface MemoriesCarouselProps {
  circleId: string | null;
}

const SKELETON_COUNT = 5;
/** One card + gap; the exact figure only has to feel like "about a page". */
const SCROLL_STEP_PX = 300;

/**
 * The Home memories row (epic #300, issue #309).
 *
 * SELF-HIDING BY CONTRACT. This component renders `null` — contributing no
 * heading, no spacing, no empty state — whenever:
 *
 *   - `features.memories` is not strictly `true` (including while the flags are
 *     still loading, so it can never flash in), or
 *   - there is no active circle, or
 *   - the feed came back empty.
 *
 * That is deliberate and load-bearing: HomePage's header comment records that
 * dashboard clutter was removed on purpose in issue #250, and the epic requires
 * a brand-new install to look exactly as it does today. A "no memories yet"
 * placeholder on Home would violate both. The `/memories` hub is where the
 * empty state belongs, because a user who navigates there asked to see it.
 *
 * While the flag is off no request is fired at all — `useMemoriesFeed` is
 * passed `enabled: false`, not merely rendered conditionally.
 */
export function MemoriesCarousel({ circleId }: MemoriesCarouselProps) {
  const theme = useTheme();
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const enabled = useMemoriesEnabled();

  const { items, isLoading, patchMyState, removeItem, restoreItem } =
    useMemoriesFeed(circleId, enabled === true);
  const { markSeen } = useMemoryActions({ patchMyState, removeItem, restoreItem });

  const trackRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const syncScrollAffordances = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    syncScrollAffordances();
  }, [items.length, syncScrollAffordances]);

  const scrollBy = useCallback(
    (delta: number) => {
      trackRef.current?.scrollBy({
        left: delta,
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
    },
    [reduceMotion],
  );

  const handleOpen = useCallback(
    (memory: MemoryCardDto) => {
      // Opening counts as seen even if the card never dwelled in view.
      markSeen(memory.id);
      // Until the story player lands (#313) this is the detail route.
      navigate(`/memories/${memory.id}`);
    },
    [markSeen, navigate],
  );

  // Flag off / still loading / no circle — render nothing at all.
  if (enabled !== true || !circleId) return null;

  // First load: a skeleton row rather than a collapse-then-expand jump. Once
  // loading settles with nothing to show, the row disappears for good.
  if (!isLoading && items.length === 0) return null;

  return (
    <Box
      component="section"
      aria-labelledby="memories-carousel-heading"
      sx={{ px: { xs: 2, md: 3 }, pt: { xs: 2, md: 3 }, pb: 1 }}
    >
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.25 }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
          <AutoAwesomeMotionIcon color="primary" fontSize="small" />
          <Typography
            id="memories-carousel-heading"
            variant="subtitle1"
            component="h2"
            sx={{ fontWeight: 600 }}
          >
            Memories
          </Typography>
          <Typography
            component={RouterLink}
            to="/memories"
            variant="body2"
            sx={{ color: 'primary.main', textDecoration: 'none', ml: 1 }}
          >
            See all
          </Typography>
        </Stack>

        {isDesktop && (
          <Stack direction="row" spacing={0.5}>
            <IconButton
              size="small"
              aria-label="Scroll memories left"
              disabled={!canScrollLeft}
              onClick={() => scrollBy(-SCROLL_STEP_PX)}
            >
              <ChevronLeftIcon />
            </IconButton>
            <IconButton
              size="small"
              aria-label="Scroll memories right"
              disabled={!canScrollRight}
              onClick={() => scrollBy(SCROLL_STEP_PX)}
            >
              <ChevronRightIcon />
            </IconButton>
          </Stack>
        )}
      </Stack>

      <Box
        ref={trackRef}
        onScroll={syncScrollAffordances}
        sx={{
          display: 'flex',
          gap: 1.5,
          overflowX: 'auto',
          overflowY: 'hidden',
          // Scroll-snap + momentum on touch. `pb` leaves room for the hover
          // lift and the focus ring so neither is clipped by the scroller.
          scrollSnapType: 'x mandatory',
          WebkitOverflowScrolling: 'touch',
          pb: 1,
          pt: 0.5,
          // The row scrolls itself; the page never scrolls sideways because of it.
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        }}
      >
        {isLoading && items.length === 0
          ? Array.from({ length: SKELETON_COUNT }, (_, i) => (
              <MemoryCardSkeleton key={i} size="compact" />
            ))
          : items.map((memory) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                size="compact"
                onOpen={handleOpen}
                onSeen={markSeen}
              />
            ))}
      </Box>
    </Box>
  );
}
