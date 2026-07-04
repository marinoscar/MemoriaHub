/**
 * Shared location tile helpers for the tiered Places browsing surfaces.
 *
 * `param` maps a location level to the media-library query parameter that
 * filters by that level:
 *   - country  → /media?country=<name>
 *   - region   → /media?region=<name>
 *   - locality → /media?locality=<name>  (used by the "Cities" level)
 *
 * `renderLocationTile` renders the compact fixed-width (96px) carousel tile
 * used by the Explore rows on SearchPage and PlacesOverviewPage. The full-page
 * responsive grid (LevelBrowsePage) uses its own 1:1 tile layout but reuses
 * `LOCATION_PARAM_PATH` for navigation.
 */

import { Box, Typography } from '@mui/material';
import { Place as PlaceIcon } from '@mui/icons-material';
import type { useNavigate } from 'react-router-dom';
import type { ExploreLocationItem } from '../../services/media';

export type LocationParam = 'country' | 'region' | 'locality';

/** Build the media-library URL that filters to a given location value. */
export function locationHref(param: LocationParam, name: string): string {
  return `/media?${param}=${encodeURIComponent(name)}`;
}

const TILE_SIZE = 96;

/**
 * Compact carousel tile (fixed 96px) — cover image or PlaceIcon fallback,
 * name + count, keyboard accessible.
 */
export function renderLocationTile(
  item: ExploreLocationItem,
  navigate: ReturnType<typeof useNavigate>,
  param: LocationParam,
) {
  const href = locationHref(param, item.name);
  const go = () => navigate(href);

  return (
    <Box
      onClick={go}
      sx={{
        flexShrink: 0,
        width: TILE_SIZE,
        cursor: 'pointer',
        borderRadius: 2,
        overflow: 'hidden',
        '&:hover': { opacity: 0.85 },
      }}
      role="button"
      aria-label={`Browse photos from ${item.name}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') go();
      }}
    >
      <Box
        sx={{
          width: TILE_SIZE,
          height: TILE_SIZE,
          bgcolor: 'action.hover',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        {item.coverThumbnailUrl ? (
          <Box
            component="img"
            src={item.coverThumbnailUrl}
            alt={item.name}
            sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <Box
            sx={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <PlaceIcon sx={{ color: 'text.disabled', fontSize: 32 }} />
          </Box>
        )}
      </Box>
      <Typography
        variant="caption"
        sx={{
          display: 'block',
          mt: 0.5,
          px: 0.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {item.name}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
        {item.count}
      </Typography>
    </Box>
  );
}
