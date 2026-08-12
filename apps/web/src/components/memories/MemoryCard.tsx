import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  Box,
  CardActionArea,
  Skeleton,
  Typography,
  alpha,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import FavoriteIcon from '@mui/icons-material/Favorite';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import { memoryAriaLabel, formatMemoryPeriod } from './memoryFormat';
import { memoryTypeMeta } from './memoryTypeMeta';
import type { MemoryCard as MemoryCardDto, MemoryFeedCard } from '../../types/memories';

export type MemoryCardSize = 'compact' | 'large';

export interface MemoryCardProps {
  memory: MemoryCardDto | MemoryFeedCard;
  /** `compact` = the ~140x200 carousel card; `large` = the hub grid tile. */
  size?: MemoryCardSize;
  /** Hub-only: `trip` / `year_in_review` span two columns for visual rhythm. */
  wide?: boolean;
  onOpen: (memory: MemoryCardDto) => void;
  /**
   * Called once the card has been ≥90% visible for a full second. The card
   * never calls the API itself — the owning surface decides what "seen" means
   * and owns the once-per-session dedup (`useMemoryActions.markSeen`).
   */
  onSeen?: (id: string) => void;
  /** Rendered over the top-right corner (the kebab). Must NOT be a nested button. */
  action?: ReactNode;
}

/** Cover height for the compact card; the width is set by the carousel track. */
const COMPACT_WIDTH = 140;
const COMPACT_HEIGHT = 200;

/** How long a card must stay ≥90% visible before it counts as seen. */
const SEEN_DWELL_MS = 1000;
const SEEN_VISIBILITY_RATIO = 0.9;

/**
 * The one card component behind BOTH memory surfaces — the Home carousel and
 * the `/memories` hub — so their anatomy cannot drift.
 *
 * Anatomy (issue #309):
 *  - cover thumbnail filling the card, `object-fit: cover`
 *  - a bottom gradient scrim carrying the title (2-line clamp) and subtitle
 *  - a frosted type badge top-left with the per-type icon
 *  - an UNSEEN card gets a 2.5px primary→secondary gradient ring (the story-app
 *    convention); a seen card loses the ring and is slightly desaturated
 *  - `large` additionally fans up to four item thumbnails behind the cover and
 *    shows an item-count chip
 *
 * MOTION IS OPT-OUT, NOT DECORATION: every animation here (the hover lift and
 * the 6s Ken Burns zoom) is disabled under `prefers-reduced-motion: reduce`,
 * and hover effects only arm on a pointer-capable, `md`+ viewport so a touch
 * device never gets a sticky hover state.
 */
export function MemoryCard({
  memory,
  size = 'compact',
  wide = false,
  onOpen,
  onSeen,
  action,
}: MemoryCardProps) {
  const theme = useTheme();
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const rootRef = useRef<HTMLDivElement | null>(null);

  const meta = memoryTypeMeta(memory.type);
  const unseen = !memory.myState.seen;
  const period = formatMemoryPeriod(memory.periodStart, memory.periodEnd);
  const fanThumbs =
    size === 'large' && 'itemThumbnailUrls' in memory
      ? memory.itemThumbnailUrls.slice(0, 4)
      : [];

  // ---------------------------------------------------------------------------
  // Seen tracking — ≥90% visible for ≥1s. The dwell timer is what separates
  // "the user looked at this" from "this scrolled past at speed"; without it a
  // flick through the carousel would mark every card seen.
  // ---------------------------------------------------------------------------
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !onSeen || memory.myState.seen) return;
    if (typeof IntersectionObserver === 'undefined') return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries[0]?.intersectionRatio ?? 0;
        if (visible >= SEEN_VISIBILITY_RATIO) {
          if (timer) return;
          timer = setTimeout(() => {
            onSeenRef.current?.(memory.id);
          }, SEEN_DWELL_MS);
        } else if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      },
      { threshold: [0, SEEN_VISIBILITY_RATIO] },
    );
    observer.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
    // `onSeen` presence is read once; identity changes must not re-arm the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memory.id, memory.myState.seen]);

  const handleOpen = useCallback(() => {
    onOpen(memory as MemoryCardDto);
  }, [onOpen, memory]);

  const animate = !reduceMotion;
  const hoverable = isDesktop && animate;

  const ringGradient = `linear-gradient(140deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main})`;

  return (
    <Box
      ref={rootRef}
      data-testid="memory-card"
      data-memory-id={memory.id}
      data-unseen={unseen ? 'true' : 'false'}
      sx={{
        position: 'relative',
        flex: size === 'compact' ? '0 0 auto' : undefined,
        width: size === 'compact' ? COMPACT_WIDTH : '100%',
        // The ring is drawn as a gradient-filled padding box around the cover,
        // which keeps it crisp at any DPR (a gradient `border` cannot be).
        p: unseen ? '2.5px' : 0,
        borderRadius: 3,
        background: unseen ? ringGradient : 'transparent',
        scrollSnapAlign: size === 'compact' ? 'start' : undefined,
        transition: animate
          ? 'transform 200ms cubic-bezier(0.2,0,0,1), box-shadow 200ms cubic-bezier(0.2,0,0,1)'
          : 'none',
        ...(hoverable && {
          '&:hover': { transform: 'scale(1.03)', boxShadow: 6 },
        }),
        // Focus stays visible regardless of the motion preference — the lift is
        // an accessibility affordance here, not decoration. Only the transform
        // half of it is dropped under reduced motion. Declared AFTER the hover
        // block so it is not silently overwritten by a later duplicate key.
        '&:focus-within': {
          boxShadow: 6,
          ...(hoverable && { transform: 'scale(1.03)' }),
        },
      }}
    >
      {/* Stacked fan — up to four item thumbnails peeking out behind the cover.
          Only the FEED payload ships `itemThumbnailUrls`; the hub list DTO does
          not, so this is absent there by design rather than broken. */}
      {fanThumbs.length > 1 && (
        <Box aria-hidden sx={{ position: 'absolute', inset: 0, zIndex: 0 }}>
          {fanThumbs.slice(1).map((url, i) => (
            <Box
              key={url}
              component="img"
              src={url}
              alt=""
              loading="lazy"
              sx={{
                position: 'absolute',
                top: -4 - i * 3,
                right: -4 - i * 3,
                width: '38%',
                height: '28%',
                objectFit: 'cover',
                borderRadius: 2,
                border: `2px solid ${theme.palette.background.paper}`,
                boxShadow: 2,
                opacity: 0.9 - i * 0.15,
              }}
            />
          ))}
        </Box>
      )}

      <CardActionArea
        onClick={handleOpen}
        aria-label={memoryAriaLabel(memory)}
        sx={{
          position: 'relative',
          display: 'block',
          borderRadius: 3,
          overflow: 'hidden',
          zIndex: 1,
          height: size === 'compact' ? COMPACT_HEIGHT : undefined,
          // Layout-shift-free: the tile reserves its box before the image loads.
          aspectRatio: size === 'compact' ? undefined : wide ? '16 / 10' : '4 / 5',
          backgroundColor: theme.palette.action.hover,
          filter: unseen ? 'none' : 'saturate(0.88)',
        }}
      >
        {memory.coverThumbnailUrl ? (
          <Box
            component="img"
            src={memory.coverThumbnailUrl}
            alt=""
            loading="lazy"
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              transformOrigin: 'center',
              transition: animate ? 'transform 6s ease-out' : 'none',
              ...(hoverable && {
                '.MuiCardActionArea-root:hover &': { transform: 'scale(1.12)' },
                '.MuiCardActionArea-root:focus-visible &': { transform: 'scale(1.12)' },
              }),
            }}
          />
        ) : (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'text.disabled',
            }}
          >
            <PhotoLibraryIcon fontSize="large" />
          </Box>
        )}

        {/* Bottom scrim — the one place a literal rgba is allowed, because a
            legible caption over an arbitrary photo cannot be a theme token. */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(to bottom, transparent 45%, rgba(0,0,0,0.72))',
            pointerEvents: 'none',
          }}
        />

        {/* Type badge — frosted chip, top-left */}
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            left: 8,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            px: 0.75,
            py: 0.25,
            borderRadius: 10,
            fontSize: size === 'compact' ? 10 : 11,
            lineHeight: 1.6,
            color: '#fff',
            backgroundColor: 'rgba(255,255,255,0.18)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        >
          <Box component="span" sx={{ display: 'flex', fontSize: 'inherit' }}>
            {meta.icon()}
          </Box>
          <Box component="span" sx={{ fontWeight: 600 }}>
            {meta.label}
          </Box>
        </Box>

        {/* Favorite + item count, top-right (kebab, when present, sits above) */}
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            right: action ? 40 : 8,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
          }}
        >
          {memory.myState.favorited && (
            <FavoriteIcon
              aria-hidden
              sx={{ fontSize: 16, color: theme.palette.error.light }}
            />
          )}
          {size === 'large' && (
            <Box
              sx={{
                px: 0.75,
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 600,
                lineHeight: 1.8,
                color: '#fff',
                backgroundColor: 'rgba(0,0,0,0.45)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
              }}
            >
              {memory.itemCount}
            </Box>
          )}
        </Box>

        {/* Caption */}
        <Box sx={{ position: 'absolute', left: 0, right: 0, bottom: 0, p: 1.25 }}>
          <Typography
            component="div"
            sx={{
              color: '#fff',
              fontWeight: 600,
              fontSize: size === 'compact' ? 13 : 16,
              lineHeight: 1.25,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {memory.title}
          </Typography>
          <Typography
            component="div"
            sx={{
              mt: 0.25,
              fontSize: 12,
              color: 'rgba(255,255,255,0.8)',
              display: '-webkit-box',
              WebkitLineClamp: 1,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {memory.subtitle ?? period}
          </Typography>
        </Box>
      </CardActionArea>

      {/* Sibling of the action area — never nested inside it, which would be an
          invalid button-in-button and break keyboard activation. */}
      {action && (
        <Box
          sx={{
            position: 'absolute',
            top: unseen ? 6 : 4,
            right: unseen ? 6 : 4,
            zIndex: 2,
            borderRadius: '50%',
            backgroundColor: alpha('#000', 0.35),
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        >
          {action}
        </Box>
      )}
    </Box>
  );
}

/** Loading placeholder with the exact geometry of a real card — no layout shift. */
export function MemoryCardSkeleton({
  size = 'compact',
  wide = false,
}: {
  size?: MemoryCardSize;
  wide?: boolean;
}) {
  return (
    <Skeleton
      variant="rectangular"
      data-testid="memory-card-skeleton"
      sx={{
        flex: size === 'compact' ? '0 0 auto' : undefined,
        width: size === 'compact' ? COMPACT_WIDTH : '100%',
        height: size === 'compact' ? COMPACT_HEIGHT : undefined,
        aspectRatio: size === 'compact' ? undefined : wide ? '16 / 10' : '4 / 5',
        borderRadius: 3,
      }}
    />
  );
}
