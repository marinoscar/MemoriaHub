import { Box, Typography } from '@mui/material';
import type { MediaItem } from '../../types/media';

interface OnThisDayProps {
  items: MediaItem[];
  onSelect: (item: MediaItem) => void;
}

export function OnThisDay({ items, onSelect }: OnThisDayProps) {
  if (items.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled" sx={{ fontStyle: 'italic' }}>
        No memories from this day — yet.
      </Typography>
    );
  }

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        On This Day
      </Typography>
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
            alt={item.originalFilename}
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
    </Box>
  );
}
