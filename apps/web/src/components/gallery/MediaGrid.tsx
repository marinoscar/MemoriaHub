import { Box } from '@mui/material';
import type { MediaAssetDTO } from '@memoriahub/shared';
import { MediaCard } from './MediaCard';
import { GallerySkeleton } from './GallerySkeleton';
import { EmptyGallery } from './EmptyGallery';

interface MediaGridProps {
  /** List of media assets to display */
  media: MediaAssetDTO[];
  /** Whether data is loading */
  isLoading?: boolean;
  /** Click handler for media cards */
  onMediaClick: (mediaId: string) => void;
  /** Click handler for upload button in empty state */
  onUploadClick?: () => void;
}

/**
 * Responsive grid layout for displaying media thumbnails
 * 4 columns on desktop, 3 on tablet, 2 on mobile
 */
export function MediaGrid({ media, isLoading, onMediaClick, onUploadClick }: MediaGridProps) {
  // Show skeleton while loading and no media yet
  if (isLoading && media.length === 0) {
    return <GallerySkeleton />;
  }

  // Show empty state
  if (!isLoading && media.length === 0) {
    return <EmptyGallery onUploadClick={onUploadClick ?? (() => {})} />;
  }

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
      {media.map((item) => (
        <MediaCard key={item.id} media={item} onClick={onMediaClick} />
      ))}
    </Box>
  );
}
