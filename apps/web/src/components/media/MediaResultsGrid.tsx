import { useState } from 'react';
import {
  Box,
  Typography,
  ImageListItem,
  ImageListItemBar,
  IconButton,
  Tooltip,
  CircularProgress,
  Skeleton,
} from '@mui/material';
import {
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  PhotoLibrary as PhotoLibraryIcon,
  PlayCircleOutlined as PlayCircleOutlinedIcon,
  CheckBoxOutlineBlank as CheckBoxOutlineBlankIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import type { MediaItem } from '../../types/media';

// ---------------------------------------------------------------------------
// MediaTile — copied from MediaLibraryPage for reuse without modifying the original
// ---------------------------------------------------------------------------

interface MediaTileProps {
  item: MediaItem;
  colCount: number;
  onSelect: (item: MediaItem) => void;
  onToggleFavorite: (item: MediaItem) => void;
  isSelected: boolean;
  anySelected: boolean;
  onToggleSelect: (id: string) => void;
}

function MediaTile({
  item,
  onSelect,
  onToggleFavorite,
  isSelected,
  anySelected,
  onToggleSelect,
}: MediaTileProps) {
  const theme = useTheme();
  const [imgError, setImgError] = useState(false);

  const thumbUrl = item.thumbnailUrl;

  return (
    <ImageListItem
      onClick={() => {
        if (anySelected) {
          onToggleSelect(item.id);
        } else {
          onSelect(item);
        }
      }}
      sx={{
        position: 'relative',
        cursor: 'pointer',
        overflow: 'hidden',
        borderRadius: 1,
        border: `1px solid ${theme.palette.divider}`,
        aspectRatio: '1',
        '&:hover .media-overlay': { opacity: 1 },
      }}
    >
      {thumbUrl && !imgError ? (
        <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
          <Box
            component="img"
            src={thumbUrl}
            alt={item.title ?? item.originalFilename}
            onError={() => setImgError(true)}
            sx={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
          {item.type === 'video' && (
            <Box
              aria-label="video"
              data-testid="play-indicator"
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
              }}
            >
              <PlayCircleOutlinedIcon
                sx={{
                  fontSize: 48,
                  color: 'rgba(255,255,255,0.85)',
                  filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.5))',
                }}
              />
            </Box>
          )}
        </Box>
      ) : (item.type === 'photo' || item.type === 'video') && !imgError ? (
        <Box
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <Skeleton
            variant="rectangular"
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
            }}
            aria-hidden="true"
          />
          <CircularProgress
            size={28}
            aria-label="Processing thumbnail"
            sx={{ position: 'relative', zIndex: 1 }}
          />
          <Typography
            variant="caption"
            sx={{
              position: 'relative',
              zIndex: 1,
              color: 'text.secondary',
            }}
          >
            Processing…
          </Typography>
        </Box>
      ) : (
        <Box
          sx={{
            width: '100%',
            height: '100%',
            backgroundColor: theme.palette.grey[800],
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <PhotoLibraryIcon
            sx={{ fontSize: 40, color: theme.palette.grey[600] }}
          />
        </Box>
      )}

      {/* Selection checkbox — shown on hover or when any item is selected */}
      <Box
        className="select-overlay"
        sx={{
          position: 'absolute',
          top: 4,
          left: 4,
          zIndex: 2,
          opacity: anySelected || isSelected ? 1 : 0,
          transition: 'opacity 0.15s',
          '.MuiImageListItem-root:hover &': { opacity: 1 },
        }}
      >
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(item.id);
          }}
          aria-label={isSelected ? 'Deselect item' : 'Select item'}
          sx={{
            color: isSelected ? 'primary.main' : 'white',
            backgroundColor: 'rgba(0,0,0,0.4)',
            '&:hover': { backgroundColor: 'rgba(0,0,0,0.6)' },
            p: 0.25,
          }}
        >
          <CheckBoxOutlineBlankIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Overlay gradient */}
      <Box
        className="media-overlay"
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background:
            'linear-gradient(to top, rgba(0,0,0,0.6) 0%, transparent 50%)',
          opacity: item.favorite ? 1 : 0,
          transition: 'opacity 0.2s',
        }}
      />

      <ImageListItemBar
        sx={{
          background: 'transparent',
          '& .MuiImageListItemBar-titleWrap': { display: 'none' },
        }}
        actionIcon={
          <Tooltip title={item.favorite ? 'Remove from favorites' : 'Add to favorites'}>
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite(item);
              }}
              aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
              sx={{ color: item.favorite ? theme.palette.warning.main : 'white' }}
            >
              {item.favorite ? <StarIcon /> : <StarBorderIcon />}
            </IconButton>
          </Tooltip>
        }
        position="top"
        actionPosition="right"
      />
    </ImageListItem>
  );
}

// ---------------------------------------------------------------------------
// MediaResultsGrid
// ---------------------------------------------------------------------------

export interface MediaResultsGridProps {
  items: MediaItem[];
  onSelect?: (item: MediaItem) => void;
  onToggleFavorite?: (item: MediaItem) => void;
}

export function MediaResultsGrid({
  items,
  onSelect,
  onToggleFavorite,
}: MediaResultsGridProps) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: '1fr',
          md: 'repeat(2, 1fr)',
          lg: 'repeat(4, 1fr)',
        },
        gap: 1,
      }}
    >
      {items.map((item) => (
        <MediaTile
          key={item.id}
          item={item}
          colCount={4}
          onSelect={onSelect ?? (() => {})}
          onToggleFavorite={onToggleFavorite ?? (() => {})}
          isSelected={false}
          anySelected={false}
          onToggleSelect={() => {}}
        />
      ))}
    </Box>
  );
}
