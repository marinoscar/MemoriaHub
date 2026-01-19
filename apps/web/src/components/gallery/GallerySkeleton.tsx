import { Box, Skeleton } from '@mui/material';

interface GallerySkeletonProps {
  /** Number of skeleton items to show */
  count?: number;
}

/**
 * Loading skeleton for the media grid
 * Matches the responsive grid layout of MediaGrid
 */
export function GallerySkeleton({ count = 12 }: GallerySkeletonProps) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'repeat(2, 1fr)',
          sm: 'repeat(3, 1fr)',
          md: 'repeat(4, 1fr)',
        },
        gap: 1,
      }}
    >
      {Array.from({ length: count }).map((_, index) => (
        <Skeleton
          key={`skeleton-${index}`}
          variant="rectangular"
          sx={{
            aspectRatio: '1',
            borderRadius: 1,
          }}
          animation="wave"
        />
      ))}
    </Box>
  );
}
