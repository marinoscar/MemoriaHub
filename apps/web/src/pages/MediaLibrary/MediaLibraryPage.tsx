import {
  useState,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import {
  Box,
  Typography,
  Grid,
  Chip,
  Stack,
  Tooltip,
  Divider,
  TextField,
  InputAdornment,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  CircularProgress,
  Alert,
  Badge,
  Button,
  Collapse,
  ToggleButton,
  ToggleButtonGroup,
  Paper,
  Menu,
  Switch,
  FormControlLabel,
} from '@mui/material';
import {
  Star as StarIcon,
  FilterList as FilterIcon,
  Search as SearchIcon,
  FileDownload as ExportIcon,
  Person as PersonIcon,
} from '@mui/icons-material';
import { useSearchParams } from 'react-router-dom';
import { useMedia } from '../../hooks/useMedia';
import { useAlbums } from '../../hooks/useAlbums';
import { useCircle } from '../../hooks/useCircle';
import { listTags, exportMedia } from '../../services/media';
import type { ExportFilters } from '../../services/media';
import { MediaGallery } from '../../components/media/MediaGallery';
import type { MediaItem, MediaQueryParams, TagItem, MediaType } from '../../types/media';
import { PersonMultiSelect } from '../../components/search/PersonMultiSelect';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive unique geo facets from the current item set. */
function deriveGeoFacets(items: MediaItem[]) {
  const countries = new Set<string>();
  const regionsByCountry = new Map<string, Set<string>>();
  const citiesByRegion = new Map<string, Set<string>>();

  for (const item of items) {
    if (item.geoCountry) {
      countries.add(item.geoCountry);
      if (item.geoAdmin1) {
        if (!regionsByCountry.has(item.geoCountry)) {
          regionsByCountry.set(item.geoCountry, new Set());
        }
        regionsByCountry.get(item.geoCountry)!.add(item.geoAdmin1);

        if (item.geoLocality) {
          const regionKey = `${item.geoCountry}::${item.geoAdmin1}`;
          if (!citiesByRegion.has(regionKey)) {
            citiesByRegion.set(regionKey, new Set());
          }
          citiesByRegion.get(regionKey)!.add(item.geoLocality);
        }
      }
    }
  }

  return { countries, regionsByCountry, citiesByRegion };
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function MediaLibraryPage() {
  const { activeCircle, activeCircleRole } = useCircle();

  const [searchParams, setSearchParams] = useSearchParams();

  // Person filter — set when navigating from PeoplePage
  const personId = searchParams.get('personId');
  const personName = searchParams.get('personName');

  // Seed people filter from URL deep-link (personId from PeoplePage) — mount only
  useEffect(() => {
    if (personId) {
      setPeopleFilter({ ids: [personId], mode: 'any' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // useMedia is retained solely to derive the location facets (country / region /
  // city pick-lists) from a lightweight sample of the current filter's items.
  // The gallery below owns all display, paging, selection, and bulk actions.
  const { items, fetchMedia } = useMedia();

  const { albums, fetchAlbums } = useAlbums();

  const [tags, setTags] = useState<TagItem[]>([]);
  // Seed a single tag filter from URL deep-link (e.g. /media?tag=beach)
  const [selectedTags, setSelectedTags] = useState<string[]>(
    searchParams.get('tag') ? [searchParams.get('tag')!] : [],
  );

  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [filterType, setFilterType] = useState<MediaType | ''>((searchParams.get('type') as MediaType) || '');
  const [filterFavorite, setFilterFavorite] = useState(searchParams.get('favorite') === '1');
  const [filterAlbum, setFilterAlbum] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [sortBy, setSortBy] = useState<'capturedAt' | 'importedAt' | 'createdAt'>('capturedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [filterMissingGeo, setFilterMissingGeo] = useState<boolean>(searchParams.get('missingGeo') === '1');
  const [filterNoFaces, setFilterNoFaces] = useState<boolean>(searchParams.get('noFaces') === '1');
  const [filterCameraMake, setFilterCameraMake] = useState<string>(searchParams.get('cameraMake') || '');
  const [filterCameraModel, setFilterCameraModel] = useState<string>(searchParams.get('cameraModel') || '');
  const [filterDeviceName, setFilterDeviceName] = useState<string>(searchParams.get('sourceDeviceName') || '');

  // Multi-person filter
  const [peopleFilter, setPeopleFilter] = useState<{ ids: string[]; mode: 'any' | 'all' }>({ ids: [], mode: 'any' });

  // Location drill-down (seeded from URL deep-links, e.g. /media?locality=…)
  const [filterCountry, setFilterCountry] = useState(searchParams.get('country') || '');
  const [filterRegion, setFilterRegion] = useState(searchParams.get('region') || '');
  const [filterLocality, setFilterLocality] = useState(searchParams.get('locality') || '');
  const [locationSearch, setLocationSearch] = useState('');

  // Export menu
  const [exportAnchorEl, setExportAnchorEl] = useState<null | HTMLElement>(null);
  const exportMenuOpen = Boolean(exportAnchorEl);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const geoFacets = useMemo(() => deriveGeoFacets(items), [items]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filterType) count++;
    if (filterFavorite) count++;
    if (filterAlbum) count++;
    if (filterDateFrom) count++;
    if (filterDateTo) count++;
    if (selectedTags.length > 0) count++;
    if (filterCountry) count++;
    if (filterRegion) count++;
    if (filterLocality) count++;
    if (locationSearch) count++;
    if (filterCameraMake) count++;
    if (filterCameraModel) count++;
    if (filterDeviceName) count++;
    if (filterMissingGeo) count++;
    if (filterNoFaces) count++;
    if (peopleFilter.ids.length > 0) count++;
    return count;
  }, [
    filterType,
    filterFavorite,
    filterAlbum,
    filterDateFrom,
    filterDateTo,
    selectedTags,
    filterCountry,
    filterRegion,
    filterLocality,
    locationSearch,
    filterCameraMake,
    filterCameraModel,
    filterDeviceName,
    filterMissingGeo,
    filterNoFaces,
    peopleFilter,
  ]);

  // Build the query params for BOTH the gallery feed and the facet sample.
  // Pagination is intentionally omitted — the gallery / useInfiniteMedia hook
  // manage paging via infinite scroll.
  const buildParams = useCallback((): MediaQueryParams => {
    const params: MediaQueryParams = {
      sortBy,
      sortOrder,
    };
    if (activeCircle) params.circleId = activeCircle.id;
    if (filterType) params.type = filterType;
    if (filterFavorite) params.favorite = true;
    if (filterAlbum) params.albumId = filterAlbum;
    if (filterDateFrom) params.capturedAtFrom = new Date(filterDateFrom).toISOString();
    if (filterDateTo) params.capturedAtTo = new Date(filterDateTo).toISOString();
    if (selectedTags.length === 1) params.tag = selectedTags[0];
    if (filterCountry) params.country = filterCountry;
    if (filterRegion) params.region = filterRegion;
    if (filterLocality) params.locality = filterLocality;
    if (locationSearch) params.location = locationSearch;
    if (filterCameraMake) params.cameraMake = filterCameraMake;
    if (filterCameraModel) params.cameraModel = filterCameraModel;
    if (filterDeviceName) params.sourceDeviceName = filterDeviceName;
    if (filterMissingGeo) params.missingGeo = true;
    if (filterNoFaces) params.noFaces = true;
    if (peopleFilter.ids.length > 0) {
      params.personIds = peopleFilter.ids;
      params.peopleMatch = peopleFilter.mode;
    } else if (personId) {
      params.personId = personId;
    }
    return params;
  }, [
    sortBy,
    sortOrder,
    activeCircle,
    filterType,
    filterFavorite,
    filterAlbum,
    filterDateFrom,
    filterDateTo,
    selectedTags,
    filterCountry,
    filterRegion,
    filterLocality,
    locationSearch,
    filterCameraMake,
    filterCameraModel,
    filterDeviceName,
    filterMissingGeo,
    filterNoFaces,
    personId,
    peopleFilter,
  ]);

  const queryParams = useMemo(() => buildParams(), [buildParams]);

  // Refresh the facet sample whenever filters change. A larger page size gives
  // the location pick-lists a richer set of countries/regions/cities than the
  // default page would.
  useEffect(() => {
    if (!activeCircle) return;
    void fetchMedia({ ...queryParams, page: 1, pageSize: 200 });
  }, [activeCircle, queryParams, fetchMedia]);

  // Reflect filter changes to URL params
  useEffect(() => {
    const params = new URLSearchParams();
    if (filterMissingGeo) params.set('missingGeo', '1');
    if (filterNoFaces) params.set('noFaces', '1');
    if (filterCameraMake) params.set('cameraMake', filterCameraMake);
    if (filterCameraModel) params.set('cameraModel', filterCameraModel);
    if (filterDeviceName) params.set('sourceDeviceName', filterDeviceName);
    if (filterType) params.set('type', filterType);
    if (filterFavorite) params.set('favorite', '1');
    setSearchParams(params, { replace: true });
  }, [filterMissingGeo, filterNoFaces, filterCameraMake, filterCameraModel, filterDeviceName, filterType, filterFavorite, setSearchParams]);

  useEffect(() => {
    if (!activeCircle) return;
    void fetchAlbums({ pageSize: 100, circleId: activeCircle.id });
    listTags(activeCircle.id)
      .then(setTags)
      .catch(() => setTags([]));
  }, [fetchAlbums, activeCircle]);

  const handleToggleTag = useCallback((tagName: string) => {
    setSelectedTags((prev) =>
      prev.includes(tagName)
        ? prev.filter((t) => t !== tagName)
        : [...prev, tagName],
    );
  }, []);

  const handleCountrySelect = useCallback((country: string) => {
    setFilterCountry(country);
    setFilterRegion('');
    setFilterLocality('');
  }, []);

  const handleRegionSelect = useCallback((region: string) => {
    setFilterRegion(region);
    setFilterLocality('');
  }, []);

  const handleLocalitySelect = useCallback((locality: string) => {
    setFilterLocality(locality);
  }, []);

  const handleClearLocation = useCallback(() => {
    setFilterCountry('');
    setFilterRegion('');
    setFilterLocality('');
    setLocationSearch('');
  }, []);

  const handleExport = useCallback(
    async (format: 'json' | 'csv') => {
      setExportAnchorEl(null);
      setExportError(null);
      setExportLoading(true);

      // Only forward the filters the export endpoint supports (type + date range)
      const filters: ExportFilters = {};
      if (activeCircle) filters.circleId = activeCircle.id;
      if (filterType) filters.type = filterType;
      if (filterDateFrom) filters.from = new Date(filterDateFrom).toISOString();
      if (filterDateTo) filters.to = new Date(filterDateTo).toISOString();

      try {
        await exportMedia(format, filters);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Export failed. Please try again.';
        setExportError(message);
      } finally {
        setExportLoading(false);
      }
    },
    [activeCircle, filterType, filterDateFrom, filterDateTo],
  );

  const availableRegions = filterCountry
    ? Array.from(geoFacets.regionsByCountry.get(filterCountry) ?? []).sort()
    : [];

  const availableCities =
    filterCountry && filterRegion
      ? Array.from(
          geoFacets.citiesByRegion.get(`${filterCountry}::${filterRegion}`) ?? [],
        ).sort()
      : [];

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">
          Select a circle to view media.
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Page header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 2,
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Typography variant="h5" component="h1">
          Media Library
        </Typography>

        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Export button — opens JSON / CSV format menu */}
          <Tooltip title="Export metadata">
            <span>
              <Button
                variant="outlined"
                startIcon={exportLoading ? <CircularProgress size={16} /> : <ExportIcon />}
                disabled={exportLoading}
                aria-label="Export media metadata"
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen ? 'true' : undefined}
                aria-controls={exportMenuOpen ? 'export-format-menu' : undefined}
                onClick={(e) => setExportAnchorEl(e.currentTarget)}
                sx={{ minHeight: 44 }}
              >
                Export
              </Button>
            </span>
          </Tooltip>
          <Menu
            id="export-format-menu"
            anchorEl={exportAnchorEl}
            open={exportMenuOpen}
            onClose={() => setExportAnchorEl(null)}
            slotProps={{ list: { 'aria-labelledby': 'export-button' } }}
          >
            <MenuItem onClick={() => void handleExport('json')}>
              Export as JSON
            </MenuItem>
            <MenuItem onClick={() => void handleExport('csv')}>
              Export as CSV
            </MenuItem>
          </Menu>

          <Button
            variant={showFilters ? 'contained' : 'outlined'}
            startIcon={
              <Badge badgeContent={activeFilterCount} color="error">
                <FilterIcon />
              </Badge>
            }
            onClick={() => setShowFilters((prev) => !prev)}
            sx={{ minHeight: 44 }}
          >
            Filters
          </Button>
        </Stack>
      </Box>

      {/* Filter panel */}
      <Collapse in={showFilters}>
        <Paper
          variant="outlined"
          sx={{ p: 2, mb: 2 }}
        >
          <Grid container spacing={2}>
            {/* Type filter */}
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <FormControl size="small" fullWidth>
                <InputLabel>Type</InputLabel>
                <Select
                  label="Type"
                  value={filterType}
                  onChange={(e) => {
                    setFilterType(e.target.value as MediaType | '');
                  }}
                >
                  <MenuItem value="">All types</MenuItem>
                  <MenuItem value="photo">Photos</MenuItem>
                  <MenuItem value="video">Videos</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            {/* Album filter */}
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <FormControl size="small" fullWidth>
                <InputLabel>Album</InputLabel>
                <Select
                  label="Album"
                  value={filterAlbum}
                  onChange={(e) => {
                    setFilterAlbum(e.target.value);
                  }}
                >
                  <MenuItem value="">All albums</MenuItem>
                  {albums.map((album) => (
                    <MenuItem key={album.id} value={album.id}>
                      {album.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>

            {/* Sort */}
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <FormControl size="small" fullWidth>
                <InputLabel>Sort By</InputLabel>
                <Select
                  label="Sort By"
                  value={`${sortBy}:${sortOrder}`}
                  onChange={(e) => {
                    const [by, order] = e.target.value.split(':');
                    setSortBy(by as typeof sortBy);
                    setSortOrder(order as typeof sortOrder);
                  }}
                >
                  <MenuItem value="capturedAt:desc">Captured — Newest</MenuItem>
                  <MenuItem value="capturedAt:asc">Captured — Oldest</MenuItem>
                  <MenuItem value="importedAt:desc">Imported — Newest</MenuItem>
                  <MenuItem value="createdAt:desc">Added — Newest</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            {/* Date range */}
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="Captured From"
                type="date"
                size="small"
                fullWidth
                value={filterDateFrom}
                onChange={(e) => {
                  setFilterDateFrom(e.target.value);
                }}
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                label="Captured To"
                type="date"
                size="small"
                fullWidth
                value={filterDateTo}
                onChange={(e) => {
                  setFilterDateTo(e.target.value);
                }}
                slotProps={{ inputLabel: { shrink: true } }}
              />
            </Grid>

            {/* Favorite toggle */}
            <Grid size={{ xs: 12 }}>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={filterFavorite ? 'favorites' : 'all'}
                onChange={(_, val) => {
                  setFilterFavorite(val === 'favorites');
                }}
                sx={{ flexWrap: 'wrap' }}
              >
                <ToggleButton value="all">All</ToggleButton>
                <ToggleButton value="favorites">
                  <StarIcon sx={{ mr: 0.5, fontSize: 16 }} /> Favorites only
                </ToggleButton>
              </ToggleButtonGroup>
            </Grid>

            {/* Camera / device filters */}
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                label="Camera Make"
                size="small"
                fullWidth
                value={filterCameraMake}
                onChange={(e) => { setFilterCameraMake(e.target.value); }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                label="Camera Model"
                size="small"
                fullWidth
                value={filterCameraModel}
                onChange={(e) => { setFilterCameraModel(e.target.value); }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                label="Device Name"
                size="small"
                fullWidth
                value={filterDeviceName}
                onChange={(e) => { setFilterDeviceName(e.target.value); }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={filterMissingGeo}
                    onChange={(e) => { setFilterMissingGeo(e.target.checked); }}
                    size="small"
                  />
                }
                label="Missing location only"
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={filterNoFaces}
                    onChange={(e) => { setFilterNoFaces(e.target.checked); }}
                    size="small"
                  />
                }
                label="No faces only"
              />
            </Grid>

            {/* Location drill-down */}
            <Grid size={{ xs: 12 }}>
              <Divider sx={{ my: 0.5 }} />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                Filter by Location
              </Typography>
              <Stack spacing={1}>
                {/* Free-text place search */}
                <TextField
                  size="small"
                  fullWidth
                  label="Search place"
                  placeholder="e.g. California, Costa Rica, Yosemite"
                  value={locationSearch}
                  onChange={(e) => {
                    setLocationSearch(e.target.value);
                    // Clear structured facets when free-texting
                    if (e.target.value) {
                      setFilterCountry('');
                      setFilterRegion('');
                      setFilterLocality('');
                    }
                  }}
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchIcon fontSize="small" />
                        </InputAdornment>
                      ),
                    },
                  }}
                />

                {/* Structured facets — country */}
                {geoFacets.countries.size > 0 && !locationSearch && (
                  <FormControl size="small" fullWidth>
                    <InputLabel>Country</InputLabel>
                    <Select
                      label="Country"
                      value={filterCountry}
                      onChange={(e) => handleCountrySelect(e.target.value)}
                    >
                      <MenuItem value="">All countries</MenuItem>
                      {Array.from(geoFacets.countries).sort().map((c) => (
                        <MenuItem key={c} value={c}>{c}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}

                {/* Region (state/province) — only visible when country selected */}
                {filterCountry && availableRegions.length > 0 && (
                  <FormControl size="small" fullWidth>
                    <InputLabel>Region</InputLabel>
                    <Select
                      label="Region"
                      value={filterRegion}
                      onChange={(e) => handleRegionSelect(e.target.value)}
                    >
                      <MenuItem value="">All regions</MenuItem>
                      {availableRegions.map((r) => (
                        <MenuItem key={r} value={r}>{r}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}

                {/* City — only visible when region selected */}
                {filterRegion && availableCities.length > 0 && (
                  <FormControl size="small" fullWidth>
                    <InputLabel>City</InputLabel>
                    <Select
                      label="City"
                      value={filterLocality}
                      onChange={(e) => handleLocalitySelect(e.target.value)}
                    >
                      <MenuItem value="">All cities</MenuItem>
                      {availableCities.map((city) => (
                        <MenuItem key={city} value={city}>{city}</MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}

                {(filterCountry || filterRegion || filterLocality || locationSearch) && (
                  <Button size="small" onClick={handleClearLocation}>
                    Clear location filters
                  </Button>
                )}
              </Stack>
            </Grid>

            {/* People filter */}
            <Grid size={{ xs: 12 }}>
              <Divider sx={{ my: 0.5 }} />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                Filter by People
              </Typography>
              <PersonMultiSelect
                circleId={activeCircle?.id ?? ''}
                value={peopleFilter}
                onChange={(next) => {
                  setPeopleFilter(next);
                  // Clear URL personId deep-link when user changes the people filter
                  if (personId) {
                    const nextParams = new URLSearchParams(searchParams);
                    nextParams.delete('personId');
                    nextParams.delete('personName');
                    setSearchParams(nextParams, { replace: true });
                  }
                }}
                label="People"
              />
              {peopleFilter.ids.length > 0 && (
                <Button
                  size="small"
                  sx={{ mt: 1, minHeight: 44 }}
                  onClick={() => { setPeopleFilter({ ids: [], mode: 'any' }); }}
                >
                  Clear people filter
                </Button>
              )}
            </Grid>
          </Grid>
        </Paper>
      </Collapse>

      {/* Person filter chip — shown when navigating from People page and no multiselect override */}
      {personId && peopleFilter.ids.length === 0 && (
        <Box sx={{ mb: 2 }}>
          <Chip
            icon={<PersonIcon />}
            label={`Showing photos of ${personName ?? 'a person'}`}
            color="primary"
            onDelete={() => {
              const next = new URLSearchParams(searchParams);
              next.delete('personId');
              next.delete('personName');
              setSearchParams(next, { replace: true });
            }}
          />
        </Box>
      )}

      {/* Tag chips */}
      {tags.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 2 }}>
          {tags.map((tag) => (
            <Chip
              key={tag.id}
              label={`${tag.name} (${tag.count})`}
              size="small"
              onClick={() => handleToggleTag(tag.name)}
              color={selectedTags.includes(tag.name) ? 'primary' : 'default'}
              variant={selectedTags.includes(tag.name) ? 'filled' : 'outlined'}
            />
          ))}
          {selectedTags.length > 0 && (
            <Chip
              label="Clear tags"
              size="small"
              variant="outlined"
              onClick={() => setSelectedTags([])}
            />
          )}
        </Box>
      )}

      {/* Export error */}
      {exportError && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          onClose={() => setExportError(null)}
        >
          {exportError}
        </Alert>
      )}

      {/* Media grid — infinite scroll with day grouping, selection, and bulk
          actions all owned by the canonical MediaGallery (home mode). Changing
          any filter mutates queryParams → the feed resets to page 1. */}
      <MediaGallery
        circleId={activeCircle.id}
        activeCircleRole={activeCircleRole}
        queryParams={queryParams}
        mode="home"
      />
    </Box>
  );
}
