import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Typography,
  Stack,
  FormControlLabel,
  Switch,
  IconButton,
  CircularProgress,
  Alert,
  Autocomplete,
  Slider,
  ToggleButtonGroup,
  ToggleButton,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Link,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  Close as CloseIcon,
  Tune as TuneIcon,
  ExpandMore as ExpandMoreIcon,
} from '@mui/icons-material';
import { PersonMultiSelect } from './PersonMultiSelect';
import { LocationPickerMap } from '../media/LocationPickerMap';
import { performSearch } from '../../services/search';
import { getExploreTags, getLocationFacets } from '../../services/media';
import type { LocationCountry } from '../../services/media';
import type { ExploreItem } from '../../services/media';
import type { MediaItem } from '../../types/media';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchPanelProps {
  open: boolean;
  onClose: () => void;
  circleId: string;
  onResults: (items: MediaItem[], totalItems: number) => void;
}

type LocationMode = 'picklists' | 'map';
type MediaTypeFilter = 'all' | 'photo' | 'video';

interface PicklistOption {
  label: string;
  value: string;
}

// ---------------------------------------------------------------------------
// SectionHeader — subtitle2 bold heading used throughout the panel
// ---------------------------------------------------------------------------
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
      {children}
    </Typography>
  );
}

// ---------------------------------------------------------------------------
// SearchPanel
// ---------------------------------------------------------------------------

export function SearchPanel({ open, onClose, circleId, onResults }: SearchPanelProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------
  const [facets, setFacets] = useState<LocationCountry[]>([]);
  const [tags, setTags] = useState<ExploreItem[]>([]);
  const [isLoadingFacets, setIsLoadingFacets] = useState(false);
  const [isLoadingTags, setIsLoadingTags] = useState(false);

  useEffect(() => {
    if (!open || !circleId) return;
    setIsLoadingFacets(true);
    setIsLoadingTags(true);

    void getLocationFacets(circleId)
      .then((data) => setFacets(data))
      .catch(() => setFacets([]))
      .finally(() => setIsLoadingFacets(false));

    void getExploreTags(circleId)
      .then((data) => setTags(data))
      .catch(() => setTags([]))
      .finally(() => setIsLoadingTags(false));
  }, [open, circleId]);

  const isLoading = isLoadingFacets || isLoadingTags;

  // -------------------------------------------------------------------------
  // Filter state
  // -------------------------------------------------------------------------
  const [peopleValue, setPeopleValue] = useState<{ ids: string[]; mode: 'all' | 'any' }>({
    ids: [],
    mode: 'all',
  });

  // Location
  const [locationMode, setLocationMode] = useState<LocationMode>('picklists');
  const [selectedCountry, setSelectedCountry] = useState<PicklistOption | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<PicklistOption | null>(null);
  const [selectedLocality, setSelectedLocality] = useState<PicklistOption | null>(null);
  const [pinLocation, setPinLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [radiusKm, setRadiusKm] = useState(25);

  // Date
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Media type
  const [mediaType, setMediaType] = useState<MediaTypeFilter>('all');

  // Tag
  const [selectedTag, setSelectedTag] = useState<ExploreItem | null>(null);

  // AI
  const [semanticQuery, setSemanticQuery] = useState('');

  // More filters (booleans)
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [excludeArchived, setExcludeArchived] = useState(false);
  const [missingCapturedAt, setMissingCapturedAt] = useState(false);
  const [missingGeo, setMissingGeo] = useState(false);
  const [missingCamera, setMissingCamera] = useState(false);
  const [noFaces, setNoFaces] = useState(false);
  const [cameraMake, setCameraMake] = useState('');
  const [cameraModel, setCameraModel] = useState('');

  // Search state
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Derived picklist options
  // -------------------------------------------------------------------------
  const countryOptions: PicklistOption[] = facets.map((f) => ({
    label: `${f.country} (${f.count})`,
    value: f.country,
  }));

  const regionOptions: PicklistOption[] =
    facets
      .find((f) => f.country === selectedCountry?.value)
      ?.regions.map((r) => ({ label: `${r.name} (${r.count})`, value: r.name })) ?? [];

  const localityOptions: PicklistOption[] =
    facets
      .find((f) => f.country === selectedCountry?.value)
      ?.regions.find((r) => r.name === selectedRegion?.value)
      ?.localities.map((l) => ({ label: `${l.name} (${l.count})`, value: l.name })) ?? [];

  // -------------------------------------------------------------------------
  // handleClearAll
  // -------------------------------------------------------------------------
  const handleClearAll = () => {
    setPeopleValue({ ids: [], mode: 'all' });
    setLocationMode('picklists');
    setSelectedCountry(null);
    setSelectedRegion(null);
    setSelectedLocality(null);
    setPinLocation(null);
    setRadiusKm(25);
    setDateFrom('');
    setDateTo('');
    setMediaType('all');
    setSelectedTag(null);
    setSemanticQuery('');
    setFavoritesOnly(false);
    setExcludeArchived(false);
    setMissingCapturedAt(false);
    setMissingGeo(false);
    setMissingCamera(false);
    setNoFaces(false);
    setCameraMake('');
    setCameraModel('');
    setSearchError(null);
  };

  // -------------------------------------------------------------------------
  // handleSearch
  // -------------------------------------------------------------------------
  const handleSearch = async () => {
    if (!circleId) return;
    setIsSearching(true);
    setSearchError(null);
    try {
      const filters: Record<string, unknown> = {};

      // People
      if (peopleValue.ids.length > 0) {
        filters['people'] = peopleValue;
      }

      // Location
      if (locationMode === 'picklists') {
        if (selectedLocality) {
          filters['locality'] = selectedLocality.value;
          if (selectedRegion) filters['region'] = selectedRegion.value;
          if (selectedCountry) filters['country'] = selectedCountry.value;
        } else if (selectedRegion) {
          filters['region'] = selectedRegion.value;
          if (selectedCountry) filters['country'] = selectedCountry.value;
        } else if (selectedCountry) {
          filters['country'] = selectedCountry.value;
        }
      } else if (locationMode === 'map' && pinLocation) {
        filters['near'] = { lat: pinLocation.lat, lng: pinLocation.lng, radiusKm };
      }

      // Date
      if (dateFrom || dateTo) {
        const capturedAt: { from?: string; to?: string } = {};
        if (dateFrom) capturedAt.from = new Date(dateFrom + 'T00:00:00.000Z').toISOString();
        if (dateTo) capturedAt.to = new Date(dateTo + 'T23:59:59.999Z').toISOString();
        filters['capturedAt'] = capturedAt;
      }

      // Media type
      if (mediaType !== 'all') {
        filters['type'] = mediaType;
      }

      // Tag
      if (selectedTag) {
        filters['tag'] = selectedTag.name;
      }

      // Flags (only include when true)
      if (favoritesOnly) filters['favorite'] = true;
      if (excludeArchived) filters['excludeArchived'] = true;
      if (missingCapturedAt) filters['missingCapturedAt'] = true;
      if (missingGeo) filters['missingGeo'] = true;
      if (missingCamera) filters['missingCamera'] = true;
      if (noFaces) filters['noFaces'] = true;

      // Camera
      if (cameraMake.trim()) filters['cameraMake'] = cameraMake.trim();
      if (cameraModel.trim()) filters['cameraModel'] = cameraModel.trim();

      const result = await performSearch({
        circleId,
        filters,
        semanticQuery: semanticQuery.trim() || undefined,
        page: 1,
        pageSize: 20,
      });

      onResults(result.items, result.meta.totalItems);
      onClose();
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setIsSearching(false);
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      maxWidth="sm"
      fullWidth
      aria-labelledby="search-panel-title"
    >
      <DialogTitle
        id="search-panel-title"
        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 1 }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <TuneIcon />
          <Typography variant="h6" component="span">
            Search photos
          </Typography>
        </Box>
        <IconButton size="small" onClick={onClose} aria-label="Close search panel">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ pt: 2 }}>
        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <Stack spacing={3}>
            {/* ----------------------------------------------------------------
                A. People
            ----------------------------------------------------------------- */}
            <Box>
              <SectionHeader>People</SectionHeader>
              <PersonMultiSelect
                circleId={circleId}
                value={peopleValue}
                onChange={setPeopleValue}
                label="People"
              />
            </Box>

            {/* ----------------------------------------------------------------
                B. Location
            ----------------------------------------------------------------- */}
            <Box>
              <SectionHeader>Location</SectionHeader>

              <ToggleButtonGroup
                exclusive
                size="small"
                value={locationMode}
                onChange={(_, v: LocationMode | null) => {
                  if (v !== null) setLocationMode(v);
                }}
                sx={{ mb: 2 }}
              >
                <ToggleButton value="picklists">Pick from list</ToggleButton>
                <ToggleButton value="map">Map radius</ToggleButton>
              </ToggleButtonGroup>

              {locationMode === 'picklists' && (
                <>
                  {facets.length === 0 ? (
                    <Alert severity="info">
                      No geocoded photos yet. An admin can run a geocode backfill in{' '}
                      <Link href="/admin/settings/geo" underline="hover">
                        Admin Settings &rarr; Geo
                      </Link>
                      .
                    </Alert>
                  ) : (
                    <Stack spacing={1.5}>
                      <Autocomplete<PicklistOption>
                        options={countryOptions}
                        value={selectedCountry}
                        onChange={(_, v) => {
                          setSelectedCountry(v);
                          setSelectedRegion(null);
                          setSelectedLocality(null);
                        }}
                        getOptionLabel={(opt) => opt.label}
                        isOptionEqualToValue={(a, b) => a.value === b.value}
                        size="small"
                        fullWidth
                        renderInput={(params) => (
                          <TextField {...params} label="Country" size="small" />
                        )}
                      />
                      <Autocomplete<PicklistOption>
                        options={regionOptions}
                        value={selectedRegion}
                        disabled={!selectedCountry}
                        onChange={(_, v) => {
                          setSelectedRegion(v);
                          setSelectedLocality(null);
                        }}
                        getOptionLabel={(opt) => opt.label}
                        isOptionEqualToValue={(a, b) => a.value === b.value}
                        size="small"
                        fullWidth
                        renderInput={(params) => (
                          <TextField {...params} label="Region" size="small" />
                        )}
                      />
                      <Autocomplete<PicklistOption>
                        options={localityOptions}
                        value={selectedLocality}
                        disabled={!selectedRegion}
                        onChange={(_, v) => setSelectedLocality(v)}
                        getOptionLabel={(opt) => opt.label}
                        isOptionEqualToValue={(a, b) => a.value === b.value}
                        size="small"
                        fullWidth
                        renderInput={(params) => (
                          <TextField {...params} label="Locality" size="small" />
                        )}
                      />
                    </Stack>
                  )}
                </>
              )}

              {locationMode === 'map' && (
                <Box>
                  <LocationPickerMap
                    value={pinLocation}
                    onChange={(latlng) => setPinLocation(latlng)}
                    height={260}
                  />
                  {!pinLocation && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ mt: 0.5, display: 'block' }}
                    >
                      Click the map to drop a pin
                    </Typography>
                  )}
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    Radius: {radiusKm} km
                  </Typography>
                  <Slider
                    value={radiusKm}
                    onChange={(_, v) => setRadiusKm(Array.isArray(v) ? v[0] : v)}
                    min={1}
                    max={200}
                    step={5}
                    marks={[
                      { value: 1 },
                      { value: 25 },
                      { value: 50 },
                      { value: 100 },
                      { value: 200 },
                    ]}
                    valueLabelDisplay="auto"
                  />
                </Box>
              )}
            </Box>

            {/* ----------------------------------------------------------------
                C. Date taken
            ----------------------------------------------------------------- */}
            <Box>
              <SectionHeader>Date taken</SectionHeader>
              <Box
                sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1 }}
              >
                <TextField
                  label="From"
                  type="date"
                  size="small"
                  fullWidth
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
                <TextField
                  label="To"
                  type="date"
                  size="small"
                  fullWidth
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
              </Box>
            </Box>

            {/* ----------------------------------------------------------------
                D. Media type
            ----------------------------------------------------------------- */}
            <Box>
              <SectionHeader>Media type</SectionHeader>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={mediaType}
                onChange={(_, v: MediaTypeFilter | null) => {
                  if (v !== null) setMediaType(v);
                }}
              >
                <ToggleButton value="all">All</ToggleButton>
                <ToggleButton value="photo">Photos</ToggleButton>
                <ToggleButton value="video">Videos</ToggleButton>
              </ToggleButtonGroup>
            </Box>

            {/* ----------------------------------------------------------------
                E. Tags
            ----------------------------------------------------------------- */}
            <Box>
              <SectionHeader>Tag</SectionHeader>
              <Autocomplete<ExploreItem>
                options={tags}
                value={selectedTag}
                onChange={(_, v) => setSelectedTag(v)}
                getOptionLabel={(opt) => `${opt.name} (${opt.count})`}
                isOptionEqualToValue={(a, b) => a.name === b.name}
                noOptionsText="No tags yet"
                size="small"
                fullWidth
                renderInput={(params) => (
                  <TextField {...params} label="Tag" size="small" />
                )}
              />
            </Box>

            {/* ----------------------------------------------------------------
                F. AI description
            ----------------------------------------------------------------- */}
            <Box>
              <SectionHeader>AI description</SectionHeader>
              <TextField
                label="Describe the photo (AI)"
                multiline
                maxRows={3}
                size="small"
                fullWidth
                value={semanticQuery}
                onChange={(e) => setSemanticQuery(e.target.value)}
                helperText="Combines with filters above"
              />
            </Box>

            {/* ----------------------------------------------------------------
                G. More filters (collapsible)
            ----------------------------------------------------------------- */}
            <Accordion
              disableGutters
              elevation={0}
              sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle2">More filters</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={1}>
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={favoritesOnly}
                        onChange={(e) => setFavoritesOnly(e.target.checked)}
                      />
                    }
                    label="Favorites only"
                  />
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={excludeArchived}
                        onChange={(e) => setExcludeArchived(e.target.checked)}
                      />
                    }
                    label="Exclude archived"
                  />
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={missingCapturedAt}
                        onChange={(e) => setMissingCapturedAt(e.target.checked)}
                      />
                    }
                    label="Missing capture date"
                  />
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={missingGeo}
                        onChange={(e) => setMissingGeo(e.target.checked)}
                      />
                    }
                    label="Missing GPS"
                  />
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={missingCamera}
                        onChange={(e) => setMissingCamera(e.target.checked)}
                      />
                    }
                    label="Missing camera info"
                  />
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={noFaces}
                        onChange={(e) => setNoFaces(e.target.checked)}
                      />
                    }
                    label="No faces"
                  />
                  <TextField
                    label="Camera make"
                    size="small"
                    fullWidth
                    value={cameraMake}
                    onChange={(e) => setCameraMake(e.target.value)}
                    sx={{ mt: 1 }}
                  />
                  <TextField
                    label="Camera model"
                    size="small"
                    fullWidth
                    value={cameraModel}
                    onChange={(e) => setCameraModel(e.target.value)}
                  />
                </Stack>
              </AccordionDetails>
            </Accordion>
          </Stack>
        )}
      </DialogContent>

      {searchError && (
        <Alert severity="error" sx={{ mx: 3, mb: 1 }}>
          {searchError}
        </Alert>
      )}

      <DialogActions sx={{ px: 3, py: 2, justifyContent: 'space-between' }}>
        <Button
          variant="text"
          onClick={handleClearAll}
          disabled={isSearching}
          sx={{ minHeight: 44 }}
        >
          Clear all
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleSearch()}
          disabled={!circleId || isSearching}
          startIcon={isSearching ? <CircularProgress size={16} /> : undefined}
          sx={{ minHeight: 44 }}
        >
          Search
        </Button>
      </DialogActions>
    </Dialog>
  );
}
