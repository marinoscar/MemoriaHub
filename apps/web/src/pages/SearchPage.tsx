/**
 * SearchPage — results view + Explore (People / Places / Tags).
 *
 * When SearchContext holds results (agent or advanced), shows:
 *   - A small header with total count and a "Clear" button.
 *   - The result grid via MediaGallery (controlled mode).
 *
 * When there are no results and no in-flight search, falls back to the
 * Explore browse rows (People / Places / Tags), which existed before.
 *
 * The search input lives in the AppBar TopbarSearch; this page only
 * renders output.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Skeleton,
} from '@mui/material';
import {
  Person as PersonIcon,
  Place as PlaceIcon,
  LocalOffer as TagIcon,
} from '@mui/icons-material';
import { useCircle } from '../hooks/useCircle';
import { usePeople } from '../hooks/usePeople';
import { getExplorePlaces, getExploreTags } from '../services/media';
import type { ExploreItem } from '../services/media';
import { MediaGallery } from '../components/media/MediaGallery';
import { PersonAvatar } from '../components/people/PersonAvatar';
import { useSearch } from '../contexts/SearchContext';

// ---------------------------------------------------------------------------
// ExploreRow — horizontal scrolling row with section header
// ---------------------------------------------------------------------------

interface ExploreRowProps {
  title: string;
  icon: React.ReactNode;
  loading: boolean;
  children: React.ReactNode;
}

function ExploreRow({ title, icon, loading, children }: ExploreRowProps) {
  return (
    <Box sx={{ mb: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
        {icon}
        <Typography variant="subtitle1" fontWeight={600}>
          {title}
        </Typography>
      </Box>
      {loading ? (
        <Box sx={{ display: 'flex', gap: 1.5, overflowX: 'auto', pb: 1 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton
              key={i}
              variant="rectangular"
              sx={{ width: 96, height: 96, borderRadius: 2, flexShrink: 0 }}
            />
          ))}
        </Box>
      ) : (
        <Box sx={{ display: 'flex', gap: 1.5, overflowX: 'auto', pb: 1, '::-webkit-scrollbar': { height: 4 } }}>
          {children}
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// SearchPage
// ---------------------------------------------------------------------------

export default function SearchPage() {
  const navigate = useNavigate();
  const { activeCircle, activeCircleRole } = useCircle();
  const { data: peopleData, loading: peopleLoading } = usePeople(activeCircle?.id ?? null);
  const { results, isSearching, error, clearSearch } = useSearch();

  // Explore data (shown when no results)
  const [places, setPlaces] = useState<ExploreItem[]>([]);
  const [tags, setTags] = useState<ExploreItem[]>([]);
  const [placesLoading, setPlacesLoading] = useState(false);
  const [tagsLoading, setTagsLoading] = useState(false);

  useEffect(() => {
    if (!activeCircle) return;
    const id = activeCircle.id;

    setPlacesLoading(true);
    getExplorePlaces(id)
      .then((data) => setPlaces(data))
      .catch(() => setPlaces([]))
      .finally(() => setPlacesLoading(false));

    setTagsLoading(true);
    getExploreTags(id)
      .then((data) => setTags(data))
      .catch(() => setTags([]))
      .finally(() => setTagsLoading(false));
  }, [activeCircle]);

  const labeledPeople = (peopleData?.items ?? []).filter((p) => p.name != null).slice(0, 10);

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to search your memories.</Alert>
      </Box>
    );
  }

  // -------------------------------------------------------------------------
  // Results view
  // -------------------------------------------------------------------------
  if (results !== null || isSearching) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1200, mx: 'auto' }}>
        {/* Header row */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          {results !== null ? (
            <Typography variant="body2" color="text.secondary">
              {results.meta.totalItems} result{results.meta.totalItems !== 1 ? 's' : ''}
            </Typography>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Searching…
            </Typography>
          )}
          <Button size="small" onClick={clearSearch} sx={{ minHeight: 36 }}>
            Clear
          </Button>
        </Box>

        {/* Searching spinner (before first results arrive) */}
        {isSearching && results === null && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
            <CircularProgress />
          </Box>
        )}

        {/* Error */}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Result grid */}
        {results !== null && (
          <MediaGallery
            items={results.items}
            isLoading={isSearching}
            circleId={activeCircle.id}
            activeCircleRole={activeCircleRole}
            emptyState={
              <Typography variant="body2" color="text.secondary">
                No results found.
              </Typography>
            }
            onChange={clearSearch}
          />
        )}
      </Box>
    );
  }

  // -------------------------------------------------------------------------
  // Explore view (no results, no active search)
  // -------------------------------------------------------------------------
  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 900, mx: 'auto' }}>
      {/* People */}
      {(peopleLoading || labeledPeople.length > 0) && (
        <ExploreRow
          title="People"
          icon={<PersonIcon sx={{ color: 'text.secondary' }} />}
          loading={peopleLoading}
        >
          {labeledPeople.map((person) => (
            <Box
              key={person.id}
              onClick={() => navigate(`/media?personId=${person.id}`)}
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 0.5,
                cursor: 'pointer',
                flexShrink: 0,
                width: 80,
                '&:hover': { opacity: 0.8 },
              }}
              role="button"
              aria-label={`View photos of ${person.name}`}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ')
                  navigate(`/media?personId=${person.id}`);
              }}
            >
              <PersonAvatar person={person} size={64} />
              <Typography
                variant="caption"
                align="center"
                sx={{
                  maxWidth: 76,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  display: 'block',
                }}
              >
                {person.name}
              </Typography>
            </Box>
          ))}
        </ExploreRow>
      )}

      {/* Places */}
      <ExploreRow
        title="Places"
        icon={<PlaceIcon sx={{ color: 'text.secondary' }} />}
        loading={placesLoading}
      >
        {places.slice(0, 12).map((place) => (
          <Box
            key={place.name}
            onClick={() => navigate(`/media?locality=${encodeURIComponent(place.name)}`)}
            sx={{
              flexShrink: 0,
              width: 96,
              cursor: 'pointer',
              borderRadius: 2,
              overflow: 'hidden',
              '&:hover': { opacity: 0.85 },
            }}
            role="button"
            aria-label={`Browse photos from ${place.name}`}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ')
                navigate(`/media?locality=${encodeURIComponent(place.name)}`);
            }}
          >
            <Box
              sx={{
                width: 96,
                height: 96,
                bgcolor: 'action.hover',
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              {place.coverThumbnailUrl ? (
                <Box
                  component="img"
                  src={place.coverThumbnailUrl}
                  alt={place.name}
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
              {place.name}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
              {place.count}
            </Typography>
          </Box>
        ))}
        {places.length === 0 && !placesLoading && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            No places found. Add location data to your media.
          </Typography>
        )}
      </ExploreRow>

      {/* Tags */}
      <ExploreRow
        title="Tags"
        icon={<TagIcon sx={{ color: 'text.secondary' }} />}
        loading={tagsLoading}
      >
        {tags.slice(0, 12).map((tag) => (
          <Box
            key={tag.name}
            onClick={() => navigate(`/media?tag=${encodeURIComponent(tag.name)}`)}
            sx={{
              flexShrink: 0,
              width: 96,
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
            <Box
              sx={{
                width: 96,
                height: 96,
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
                  <TagIcon sx={{ color: 'text.disabled', fontSize: 32 }} />
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
              {tag.name}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
              {tag.count}
            </Typography>
          </Box>
        ))}
        {tags.length === 0 && !tagsLoading && (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            No tags yet. Tag your photos to see them here.
          </Typography>
        )}
      </ExploreRow>
    </Box>
  );
}
