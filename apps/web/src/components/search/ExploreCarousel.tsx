import { useRef, Fragment } from 'react';
import { Box, Typography, Button, Skeleton } from '@mui/material';
import { ChevronRight as ChevronRightIcon } from '@mui/icons-material';
import { useFittedCount } from '../../hooks/useFittedCount';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ExploreCarouselProps<T> {
  title: string;
  icon: React.ReactNode;
  loading: boolean;
  items: T[];
  /** Fixed tile width in px — used by the fit calculation. */
  itemWidth: number;
  /** Pixel gap between tiles. Defaults to 12. */
  gap?: number;
  keyOf: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  /** Label for the "View all" button. Omit to hide the button. */
  viewAllLabel?: string;
  /** Called when the user clicks the "View all" button. */
  onViewAll?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * A single-row, non-scrolling carousel used in the Explore section.
 *
 * The component measures its own width via ResizeObserver and slices the item
 * list so that exactly as many tiles fit as the row can hold — no horizontal
 * scrollbar, no clipped partial tiles.
 */
export function ExploreCarousel<T>({
  title,
  icon,
  loading,
  items,
  itemWidth,
  gap = 12,
  keyOf,
  renderItem,
  viewAllLabel,
  onViewAll,
}: ExploreCarouselProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const count = useFittedCount(containerRef, itemWidth, gap);
  const visibleItems = items.slice(0, count);

  const showViewAll = Boolean(onViewAll && viewAllLabel && items.length > 0);

  return (
    <Box sx={{ mb: 3 }}>
      {/* Header row */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 0.5,
          mb: 1.5,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {icon}
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
        </Box>

        {showViewAll && (
          <Button
            size="small"
            endIcon={<ChevronRightIcon fontSize="small" />}
            onClick={onViewAll}
            sx={{ minHeight: 32, px: 1 }}
          >
            {viewAllLabel}
          </Button>
        )}
      </Box>

      {/* Body: measuring container */}
      <Box ref={containerRef} sx={{ width: '100%' }}>
        {loading ? (
          /* Skeleton row */
          <Box
            sx={{
              display: 'flex',
              gap: `${gap}px`,
              flexWrap: 'nowrap',
              overflow: 'hidden',
            }}
          >
            {Array.from({ length: Math.max(count, 3) }).map((_, i) => (
              <Skeleton
                key={i}
                variant="rectangular"
                sx={{ width: itemWidth, height: itemWidth, borderRadius: 2, flexShrink: 0 }}
              />
            ))}
          </Box>
        ) : (
          /* Item row — exactly `count` tiles, no scroll */
          <Box
            sx={{
              display: 'flex',
              gap: `${gap}px`,
              flexWrap: 'nowrap',
              overflow: 'hidden',
            }}
          >
            {visibleItems.map((item) => (
              <Fragment key={keyOf(item)}>{renderItem(item)}</Fragment>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
