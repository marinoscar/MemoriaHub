/**
 * LevelBrowsePage — full-list responsive grid for a single location level.
 *
 * Parameterized by `level` (countries | regions | cities); serves the
 * /places/countries, /places/regions and /places/cities routes. Mirrors the
 * TagsBrowsePage grid template (1:1 tiles, cover-or-icon fallback, name+count,
 * skeletons, empty state, no-circle guard). Tiles navigate to the media
 * library filtered by the tapped location.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Typography, Alert, Skeleton } from '@mui/material';
import { Place as PlaceIcon } from '@mui/icons-material';
import { useCircle } from '../../hooks/useCircle';
import { getExploreLocationLevel } from '../../services/media';
import type { ExploreLocationItem } from '../../services/media';
import { locationHref } from './LocationTile';
import type { LocationParam } from './LocationTile';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TILE_SIZE = 96;

type Level = 'countries' | 'regions' | 'cities';

interface LevelConfig {
  title: string;
  param: LocationParam;
  emptyTitle: string;
  emptyBody: string;
  guard: string;
}

const LEVEL_CONFIG: Record<Level, LevelConfig> = {
  countries: {
    title: 'Countries',
    param: 'country',
    emptyTitle: 'No countries yet',
    emptyBody: 'Add location data to your photos to see them grouped by country.',
    guard: 'Select a circle to view countries.',
  },
  regions: {
    title: 'Regions',
    param: 'region',
    emptyTitle: 'No regions yet',
    emptyBody: 'Add location data to your photos to see them grouped by region.',
    guard: 'Select a circle to view regions.',
  },
  cities: {
    title: 'Cities',
    param: 'locality',
    emptyTitle: 'No cities yet',
    emptyBody: 'Add location data to your photos to see them grouped by city.',
    guard: 'Select a circle to view cities.',
  },
};

// ---------------------------------------------------------------------------
// LevelBrowsePage
// ---------------------------------------------------------------------------

export default function LevelBrowsePage({ level }: { level: Level }) {
  const navigate = useNavigate();
  const { activeCircle } = useCircle();

  const config = LEVEL_CONFIG[level];

  const [items, setItems] = useState<ExploreLocationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeCircle) return;
    setLoading(true);
    setFetchError(null);
    getExploreLocationLevel(activeCircle.id, level)
      .then((data) => setItems(data))
      .catch(() => setFetchError(`Failed to load ${config.title.toLowerCase()}.`))
      .finally(() => setLoading(false));
  }, [activeCircle, level, config.title]);

  // No-circle guard
  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">{config.guard}</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Page title */}
      <Typography variant="h5" component="h1" sx={{ mb: 3 }}>
        {config.title}
      </Typography>

      {fetchError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {fetchError}
        </Alert>
      )}

      {/* Loading skeletons */}
      {loading && (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_SIZE}px, 1fr))`,
            gap: 1.5,
          }}
        >
          {Array.from({ length: 18 }).map((_, i) => (
            <Skeleton
              key={i}
              variant="rectangular"
              sx={{ width: '100%', height: TILE_SIZE, borderRadius: 2 }}
            />
          ))}
        </Box>
      )}

      {/* Empty state */}
      {!loading && items.length === 0 && !fetchError && (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography variant="h6" color="text.secondary">
            {config.emptyTitle}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {config.emptyBody}
          </Typography>
        </Box>
      )}

      {/* Location grid */}
      {!loading && items.length > 0 && (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_SIZE}px, 1fr))`,
            gap: 1.5,
          }}
        >
          {items.map((item) => {
            const go = () => navigate(locationHref(config.param, item.name));
            return (
              <Box
                key={item.name}
                onClick={go}
                sx={{
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
                {/* Cover image / icon */}
                <Box
                  sx={{
                    width: '100%',
                    paddingTop: '100%', // aspect-ratio 1:1
                    position: 'relative',
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
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        display: 'block',
                      }}
                    />
                  ) : (
                    <Box
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <PlaceIcon sx={{ color: 'text.disabled', fontSize: 32 }} />
                    </Box>
                  )}
                </Box>

                {/* Name + count */}
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
          })}
        </Box>
      )}
    </Box>
  );
}
