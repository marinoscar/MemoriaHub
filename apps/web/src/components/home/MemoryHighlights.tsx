import { Box, Typography } from '@mui/material';
import type { MediaItem } from '../../types/media';

interface ThumbnailStripProps {
  items: MediaItem[];
  emptyText: string;
  onSelect: (item: MediaItem) => void;
}

function ThumbnailStrip({ items, emptyText, onSelect }: ThumbnailStripProps) {
  if (items.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled" sx={{ fontStyle: 'italic', mb: 1 }}>
        {emptyText}
      </Typography>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        overflowX: 'auto',
        gap: 1,
        pb: 1,
        '&::-webkit-scrollbar': { height: 4 },
        '&::-webkit-scrollbar-thumb': {
          backgroundColor: 'action.hover',
          borderRadius: 2,
        },
      }}
    >
      {items.map((item) => (
        <Box
          key={item.id}
          component="img"
          src={item.thumbnailUrl ?? undefined}
          alt={item.title ?? item.originalFilename}
          onClick={() => onSelect(item)}
          sx={{
            width: 120,
            height: 120,
            objectFit: 'cover',
            borderRadius: 1,
            flexShrink: 0,
            cursor: 'pointer',
            transition: 'transform 0.15s ease',
            '&:hover': {
              transform: 'scale(1.04)',
            },
          }}
        />
      ))}
    </Box>
  );
}

interface MemoryHighlightsProps {
  recent: MediaItem[];
  favorites: MediaItem[];
  onSelect: (item: MediaItem) => void;
}

export function MemoryHighlights({ recent, favorites, onSelect }: MemoryHighlightsProps) {
  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" gutterBottom>
          Recent
        </Typography>
        <ThumbnailStrip
          items={recent}
          emptyText="No recent memories."
          onSelect={onSelect}
        />
      </Box>

      <Box>
        <Typography variant="h6" gutterBottom>
          Favorites
        </Typography>
        <ThumbnailStrip
          items={favorites}
          emptyText="No favorites yet."
          onSelect={onSelect}
        />
      </Box>
    </Box>
  );
}
