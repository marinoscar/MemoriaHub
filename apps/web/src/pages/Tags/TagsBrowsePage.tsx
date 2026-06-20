import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Alert,
  Skeleton,
} from '@mui/material';
import { LocalOffer as TagIcon } from '@mui/icons-material';
import { useCircle } from '../../hooks/useCircle';
import { getExploreTags } from '../../services/media';
import type { ExploreItem } from '../../services/media';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TILE_SIZE = 96;

// ---------------------------------------------------------------------------
// TagsBrowsePage
// ---------------------------------------------------------------------------

export default function TagsBrowsePage() {
  const navigate = useNavigate();
  const { activeCircle } = useCircle();

  const [tags, setTags] = useState<ExploreItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeCircle) return;
    setLoading(true);
    setFetchError(null);
    getExploreTags(activeCircle.id)
      .then((data) => setTags(data))
      .catch(() => setFetchError('Failed to load tags.'))
      .finally(() => setLoading(false));
  }, [activeCircle]);

  // No-circle guard
  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to view tags.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Page title */}
      <Typography variant="h5" component="h1" sx={{ mb: 3 }}>
        Tags
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
      {!loading && tags.length === 0 && !fetchError && (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography variant="h6" color="text.secondary">
            No tags yet
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Tag your photos to see them here.
          </Typography>
        </Box>
      )}

      {/* Tag grid */}
      {!loading && tags.length > 0 && (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_SIZE}px, 1fr))`,
            gap: 1.5,
          }}
        >
          {tags.map((tag) => (
            <Box
              key={tag.name}
              onClick={() => navigate(`/media?tag=${encodeURIComponent(tag.name)}`)}
              sx={{
                cursor: 'pointer',
                borderRadius: 2,
                overflow: 'hidden',
                '&:hover': { opacity: 0.85 },
              }}
              role="button"
              aria-label={`Browse photos tagged ${tag.name}`}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ')
                  navigate(`/media?tag=${encodeURIComponent(tag.name)}`);
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
                {tag.coverThumbnailUrl ? (
                  <Box
                    component="img"
                    src={tag.coverThumbnailUrl}
                    alt={tag.name}
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
                    <TagIcon sx={{ color: 'text.disabled', fontSize: 32 }} />
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
                {tag.name}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
                {tag.count}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
