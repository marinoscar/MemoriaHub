/**
 * PlacesOverviewPage — the /places hub.
 *
 * Shows three Explore-style carousel rows (Countries / Regions / Cities), each
 * with a "Show all" link to the corresponding full-list grid page. Tiles
 * navigate to the media library filtered by the tapped location.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Typography, Alert } from '@mui/material';
import {
  Place as PlaceIcon,
  Public as PublicIcon,
} from '@mui/icons-material';
import { useCircle } from '../../hooks/useCircle';
import { getExploreLocations } from '../../services/media';
import type { ExploreLocations } from '../../services/media';
import { ExploreCarousel } from '../../components/search/ExploreCarousel';
import { renderLocationTile } from './LocationTile';
import type { ExploreLocationItem } from '../../services/media';

export default function PlacesOverviewPage() {
  const navigate = useNavigate();
  const { activeCircle } = useCircle();

  const [locations, setLocations] = useState<ExploreLocations>({
    countries: [],
    regions: [],
    cities: [],
  });
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeCircle) return;
    setLoading(true);
    setFetchError(null);
    getExploreLocations(activeCircle.id)
      .then((data) => setLocations(data))
      .catch(() => setFetchError('Failed to load places.'))
      .finally(() => setLoading(false));
  }, [activeCircle]);

  // No-circle guard
  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to view places.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 900, mx: 'auto' }}>
      <Typography variant="h5" component="h1" sx={{ mb: 3 }}>
        Places
      </Typography>

      {fetchError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {fetchError}
        </Alert>
      )}

      {/* Countries */}
      <ExploreCarousel<ExploreLocationItem>
        title="Countries"
        icon={<PublicIcon sx={{ color: 'text.secondary' }} />}
        loading={loading}
        items={locations.countries}
        itemWidth={96}
        gap={12}
        keyOf={(c) => c.name}
        renderItem={(c) => renderLocationTile(c, navigate, 'country')}
        viewAllLabel="Show all"
        onViewAll={() => navigate('/places/countries')}
      />

      {/* Regions */}
      <ExploreCarousel<ExploreLocationItem>
        title="Regions"
        icon={<PlaceIcon sx={{ color: 'text.secondary' }} />}
        loading={loading}
        items={locations.regions}
        itemWidth={96}
        gap={12}
        keyOf={(r) => r.name}
        renderItem={(r) => renderLocationTile(r, navigate, 'region')}
        viewAllLabel="Show all"
        onViewAll={() => navigate('/places/regions')}
      />

      {/* Cities */}
      <ExploreCarousel<ExploreLocationItem>
        title="Cities"
        icon={<PlaceIcon sx={{ color: 'text.secondary' }} />}
        loading={loading}
        items={locations.cities}
        itemWidth={96}
        gap={12}
        keyOf={(c) => c.name}
        renderItem={(c) => renderLocationTile(c, navigate, 'locality')}
        viewAllLabel="Show all"
        onViewAll={() => navigate('/places/cities')}
      />
    </Box>
  );
}
