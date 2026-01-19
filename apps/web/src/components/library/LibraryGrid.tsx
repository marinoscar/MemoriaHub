import { Box, Grid, Skeleton } from '@mui/material';
import type { LibraryDTO } from '@memoriahub/shared';
import { LibraryCard } from './LibraryCard';

interface LibraryGridProps {
  /** List of libraries to display */
  libraries: LibraryDTO[];
  /** Whether data is loading */
  isLoading?: boolean;
  /** Click handler for library cards */
  onLibraryClick?: (library: LibraryDTO) => void;
}

/**
 * Skeleton placeholder for loading state
 */
function LibraryCardSkeleton() {
  return (
    <Box sx={{ height: '100%' }}>
      <Skeleton variant="rectangular" height={140} />
      <Box sx={{ p: 2 }}>
        <Skeleton variant="text" width="60%" height={32} />
        <Skeleton variant="text" width="100%" />
        <Skeleton variant="text" width="80%" />
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1 }}>
          <Skeleton variant="text" width={60} />
          <Skeleton variant="rounded" width={80} height={24} />
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Responsive grid layout for displaying library cards
 */
export function LibraryGrid({ libraries, isLoading, onLibraryClick }: LibraryGridProps) {
  // Show skeletons while loading
  if (isLoading && libraries.length === 0) {
    return (
      <Grid container spacing={3}>
        {Array.from({ length: 6 }).map((_, index) => (
          <Grid item xs={12} sm={6} md={4} key={`skeleton-${index}`}>
            <LibraryCardSkeleton />
          </Grid>
        ))}
      </Grid>
    );
  }

  return (
    <Grid container spacing={3}>
      {libraries.map((library) => (
        <Grid item xs={12} sm={6} md={4} key={library.id}>
          <LibraryCard library={library} onClick={onLibraryClick} />
        </Grid>
      ))}
    </Grid>
  );
}
