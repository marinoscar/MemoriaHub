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
} from '@mui/material';
import {
  Person as PersonIcon,
  Place as PlaceIcon,
  Public as PublicIcon,
  LocalOffer as TagIcon,
} from '@mui/icons-material';
import { useCircle } from '../hooks/useCircle';
import { usePeople } from '../hooks/usePeople';
import { getExploreLocations, getExploreTags } from '../services/media';
import type { ExploreItem, ExploreLocations } from '../services/media';
import type { PersonListItem } from '../services/face';
import { MediaGallery } from '../components/media/MediaGallery';
import { PersonAvatar } from '../components/people/PersonAvatar';
import { useSearch } from '../contexts/SearchContext';
import { ExploreCarousel } from '../components/search/ExploreCarousel';
import { renderLocationTile } from './Places/LocationTile';
import type { ExploreLocationItem } from '../services/media';

// ---------------------------------------------------------------------------
// Tile renderers (presentational helpers)
// ---------------------------------------------------------------------------

function renderPersonTile(
  person: PersonListItem,
  navigate: ReturnType<typeof useNavigate>,
) {
  return (
    <Box
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
  );
}

function renderTagTile(
  tag: ExploreItem,
  navigate: ReturnType<typeof useNavigate>,
) {
  return (
    <Box
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
  const [locations, setLocations] = useState<ExploreLocations>({
    countries: [],
    regions: [],
    cities: [],
  });
  const [tags, setTags] = useState<ExploreItem[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [tagsLoading, setTagsLoading] = useState(false);

  useEffect(() => {
    if (!activeCircle) return;
    const id = activeCircle.id;

    setLocationsLoading(true);
    getExploreLocations(id)
      .then((data) => setLocations(data))
      .catch(() => setLocations({ countries: [], regions: [], cities: [] }))
      .finally(() => setLocationsLoading(false));

    setTagsLoading(true);
    getExploreTags(id)
      .then((data) => setTags(data))
      .catch(() => setTags([]))
      .finally(() => setTagsLoading(false));
  }, [activeCircle]);

  // Sort people: favorites first, then by face count descending.
  const people = [...(peopleData?.items ?? [])]
    .filter((p) => p.name != null)
    .sort(
      (a, b) =>
        Number(b.favorite) - Number(a.favorite) || b.faceCount - a.faceCount,
    );

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to search your photos.</Alert>
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
      {(peopleLoading || people.length > 0) && (
        <ExploreCarousel<PersonListItem>
          title="People"
          icon={<PersonIcon sx={{ color: 'text.secondary' }} />}
          loading={peopleLoading}
          items={people}
          itemWidth={80}
          gap={12}
          keyOf={(p) => p.id}
          renderItem={(p) => renderPersonTile(p, navigate)}
          viewAllLabel="View all"
          onViewAll={() => navigate('/people')}
        />
      )}

      {/* Countries */}
      <ExploreCarousel<ExploreLocationItem>
        title="Countries"
        icon={<PublicIcon sx={{ color: 'text.secondary' }} />}
        loading={locationsLoading}
        items={locations.countries}
        itemWidth={96}
        gap={12}
        keyOf={(c) => c.name}
        renderItem={(c) => renderLocationTile(c, navigate, 'country')}
        viewAllLabel="See all places"
        onViewAll={() => navigate('/places')}
      />

      {/* Regions */}
      <ExploreCarousel<ExploreLocationItem>
        title="Regions"
        icon={<PlaceIcon sx={{ color: 'text.secondary' }} />}
        loading={locationsLoading}
        items={locations.regions}
        itemWidth={96}
        gap={12}
        keyOf={(r) => r.name}
        renderItem={(r) => renderLocationTile(r, navigate, 'region')}
      />

      {/* Cities */}
      <ExploreCarousel<ExploreLocationItem>
        title="Cities"
        icon={<PlaceIcon sx={{ color: 'text.secondary' }} />}
        loading={locationsLoading}
        items={locations.cities}
        itemWidth={96}
        gap={12}
        keyOf={(c) => c.name}
        renderItem={(c) => renderLocationTile(c, navigate, 'locality')}
      />

      {/* Tags */}
      <ExploreCarousel<ExploreItem>
        title="Tags"
        icon={<TagIcon sx={{ color: 'text.secondary' }} />}
        loading={tagsLoading}
        items={tags}
        itemWidth={96}
        gap={12}
        keyOf={(t) => t.name}
        renderItem={(t) => renderTagTile(t, navigate)}
        viewAllLabel="View all"
        onViewAll={() => navigate('/tags')}
      />
    </Box>
  );
}
