import { Box } from '@mui/material';
import type { MediaAssetDTO } from '@memoriahub/shared';
import { SelectableMediaCard } from './SelectableMediaCard';
import { GallerySkeleton } from './GallerySkeleton';
import { EmptyGallery } from './EmptyGallery';

interface SelectableMediaGridProps {
  /** List of media assets to display */
  media: MediaAssetDTO[];
  /** Whether data is loading */
  isLoading?: boolean;
  /** Set of selected media IDs */
  selectedIds: Set<string>;
  /** Click handler for media cards (opens lightbox) */
  onMediaClick: (mediaId: string) => void;
  /** Selection toggle handler */
  onToggleSelection: (mediaId: string) => void;
  /** Click handler for upload button in empty state */
  onUploadClick?: () => void;
}

/**
 * Responsive grid layout for displaying selectable media thumbnails
 * 4 columns on desktop, 3 on tablet, 2 on mobile
 * Shows checkboxes on hover or when selected
 */
export function SelectableMediaGrid({
  media,
  isLoading,
  selectedIds,
  onMediaClick,
  onToggleSelection,
  onUploadClick,
}: SelectableMediaGridProps) {
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
        <SelectableMediaCard
          key={item.id}
          media={item}
          isSelected={selectedIds.has(item.id)}
          onClick={onMediaClick}
          onToggleSelection={onToggleSelection}
        />
      ))}
    </Box>
  );
}
