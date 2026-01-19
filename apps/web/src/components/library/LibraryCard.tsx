import {
  Card,
  CardActionArea,
  CardContent,
  CardMedia,
  Typography,
  Box,
  Chip,
} from '@mui/material';
import {
  Lock as PrivateIcon,
  People as SharedIcon,
  Public as PublicIcon,
  PhotoLibrary as PlaceholderIcon,
} from '@mui/icons-material';
import type { LibraryDTO } from '@memoriahub/shared';

interface LibraryCardProps {
  /** Library data to display */
  library: LibraryDTO;
  /** Click handler */
  onClick?: (library: LibraryDTO) => void;
}

/**
 * Get visibility icon and label
 */
function getVisibilityInfo(visibility: string) {
  switch (visibility) {
    case 'shared':
      return { icon: <SharedIcon fontSize="small" />, label: 'Shared' };
    case 'public':
      return { icon: <PublicIcon fontSize="small" />, label: 'Public' };
    default:
      return { icon: <PrivateIcon fontSize="small" />, label: 'Private' };
  }
}

/**
 * Card component displaying a library with cover image, name, description,
 * asset count, and visibility badge
 */
export function LibraryCard({ library, onClick }: LibraryCardProps) {
  const visibilityInfo = getVisibilityInfo(library.visibility);
  const assetCount = library.assetCount ?? 0;

  const handleClick = () => {
    onClick?.(library);
  };

  return (
    <Card
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        transition: 'transform 0.2s, box-shadow 0.2s',
        '&:hover': {
          transform: 'translateY(-4px)',
          boxShadow: 4,
        },
      }}
    >
      <CardActionArea onClick={handleClick} sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
        {/* Cover image or placeholder */}
        {library.coverUrl ? (
          <CardMedia
            component="img"
            height="140"
            image={library.coverUrl}
            alt={library.name}
            sx={{ objectFit: 'cover' }}
          />
        ) : (
          <Box
            sx={{
              height: 140,
              bgcolor: 'action.hover',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <PlaceholderIcon sx={{ fontSize: 48, color: 'text.disabled' }} />
          </Box>
        )}

        <CardContent sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
          {/* Library name */}
          <Typography
            variant="h6"
            component="h3"
            noWrap
            sx={{ fontWeight: 600, mb: 0.5 }}
          >
            {library.name}
          </Typography>

          {/* Description */}
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              mb: 1.5,
              flexGrow: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              minHeight: '2.5em',
            }}
          >
            {library.description || 'No description'}
          </Typography>

          {/* Bottom row: asset count and visibility */}
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              mt: 'auto',
            }}
          >
            <Typography variant="caption" color="text.secondary">
              {assetCount} {assetCount === 1 ? 'item' : 'items'}
            </Typography>
            <Chip
              icon={visibilityInfo.icon}
              label={visibilityInfo.label}
              size="small"
              variant="outlined"
              sx={{ height: 24 }}
            />
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}
