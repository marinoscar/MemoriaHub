import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import {
  Box,
  Typography,
  Grid,
  ImageListItem,
  ImageListItemBar,
  IconButton,
  Fab,
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
  Skeleton,
  Alert,
  Button,
  Collapse,
  Pagination,
  useMediaQuery,
  ToggleButton,
  ToggleButtonGroup,
  Paper,
  Menu,
} from '@mui/material';
import {
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  CloudUpload as UploadIcon,
  FilterList as FilterIcon,
  Search as SearchIcon,
  FileDownload as ExportIcon,
  PhotoLibrary as PhotoLibraryIcon,
  PlayCircleOutlined as PlayCircleOutlinedIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import { useMedia } from '../../hooks/useMedia';
import { useAlbums } from '../../hooks/useAlbums';
import { listTags, exportMedia } from '../../services/media';
import type { ExportFilters } from '../../services/media';
import { MediaDetailDrawer } from '../../components/media/MediaDetailDrawer';
import { MediaUploadDialog } from '../../components/media/MediaUploadDialog';
import type { MediaItem, MediaQueryParams, TagItem, MediaType, MediaClassification } from '../../types/media';

// ---------------------------------------------------------------------------
// Post-upload enrichment polling constants
// ---------------------------------------------------------------------------

/** How often (ms) to re-fetch after an upload while waiting for enrichment. */
const ENRICHMENT_POLL_INTERVAL_MS = 3_000;
/** Maximum number of poll attempts before giving up (~30 s). */
const ENRICHMENT_POLL_MAX_ATTEMPTS = 10;

/**
 * Returns true when every photo AND video item in the list already has a
 * thumbnailUrl (i.e. enrichment is complete for all media types that produce
 * thumbnails).
 */
function allItemsEnriched(items: MediaItem[]): boolean {
  return items.every(
    (item) =>
      (item.type !== 'photo' && item.type !== 'video') ||
      item.thumbnailUrl !== null,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByYearMonth(
  items: MediaItem[],
): Array<{ key: string; label: string; items: MediaItem[] }> {
  const groups = new Map<string, { label: string; items: MediaItem[] }>();

  for (const item of items) {
    let key: string;
    let label: string;

    if (!item.capturedAt) {
      key = 'unknown';
      label = 'Unknown Date';
    } else {
      const d = new Date(item.capturedAt);
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      label = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    }

    if (!groups.has(key)) {
      groups.set(key, { label, items: [] });
    }
    groups.get(key)!.items.push(item);
  }

  // Sort groups newest-first (unknown goes last)
  return Array.from(groups.entries())
    .sort(([a], [b]) => {
      if (a === 'unknown') return 1;
      if (b === 'unknown') return -1;
      return b.localeCompare(a);
    })
    .map(([key, value]) => ({ key, ...value }));
}

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
// Thumbnail tile
// ---------------------------------------------------------------------------

interface MediaTileProps {
  item: MediaItem;
  colCount: number;
  onSelect: (item: MediaItem) => void;
  onToggleFavorite: (item: MediaItem) => void;
}

function MediaTile({ item, onSelect, onToggleFavorite }: MediaTileProps) {
  const theme = useTheme();
  const [imgError, setImgError] = useState(false);

  const thumbUrl = item.thumbnailUrl;

  return (
    <ImageListItem
      onClick={() => onSelect(item)}
      sx={{
        cursor: 'pointer',
        overflow: 'hidden',
        borderRadius: 1,
        border: `1px solid ${theme.palette.divider}`,
        aspectRatio: '1',
        '&:hover .media-overlay': { opacity: 1 },
      }}
    >
      {thumbUrl && !imgError ? (
        /* Thumbnail present — show the image, plus a play indicator for videos */
        <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
          <Box
            component="img"
            src={thumbUrl}
            alt={item.title ?? item.originalFilename}
            onError={() => setImgError(true)}
            sx={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
          {item.type === 'video' && (
            <Box
              aria-label="video"
              data-testid="play-indicator"
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
              }}
            >
              <PlayCircleOutlinedIcon
                sx={{
                  fontSize: 48,
                  color: 'rgba(255,255,255,0.85)',
                  filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.5))',
                }}
              />
            </Box>
          )}
        </Box>
      ) : (item.type === 'photo' || item.type === 'video') && !imgError ? (
        /* Photo or video awaiting thumbnail enrichment — show a subtle processing state */
        <Box
          sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <Skeleton
            variant="rectangular"
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
            }}
            aria-hidden="true"
          />
          <CircularProgress
            size={28}
            aria-label="Processing thumbnail"
            sx={{ position: 'relative', zIndex: 1 }}
          />
          <Typography
            variant="caption"
            sx={{
              position: 'relative',
              zIndex: 1,
              color: 'text.secondary',
            }}
          >
            Processing…
          </Typography>
        </Box>
      ) : (
        /* Broken image — generic fallback icon */
        <Box
          sx={{
            width: '100%',
            height: '100%',
            backgroundColor: theme.palette.grey[800],
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <PhotoLibraryIcon
            sx={{ fontSize: 40, color: theme.palette.grey[600] }}
          />
        </Box>
      )}

      {/* Overlay with favorite toggle */}
      <Box
        className="media-overlay"
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background:
            'linear-gradient(to top, rgba(0,0,0,0.6) 0%, transparent 50%)',
          opacity: item.favorite ? 1 : 0,
          transition: 'opacity 0.2s',
        }}
      />

      <ImageListItemBar
        sx={{
          background: 'transparent',
          '& .MuiImageListItemBar-titleWrap': { display: 'none' },
        }}
        actionIcon={
          <Tooltip title={item.favorite ? 'Remove from favorites' : 'Add to favorites'}>
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite(item);
              }}
              aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
              sx={{ color: item.favorite ? theme.palette.warning.main : 'white' }}
            >
              {item.favorite ? <StarIcon /> : <StarBorderIcon />}
            </IconButton>
          </Tooltip>
        }
        position="top"
        actionPosition="right"
      />
    </ImageListItem>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function MediaLibraryPage() {
  const theme = useTheme();
  const isXl = useMediaQuery(theme.breakpoints.up('xl'));
  const isLg = useMediaQuery(theme.breakpoints.up('lg'));
  const isMd = useMediaQuery(theme.breakpoints.up('md'));

  const colCount = isXl || isLg ? 4 : isMd ? 2 : 1;

  const {
    items,
    meta,
    isLoading,
    error,
    fetchMedia,
    patchMedia,
    updateItemLocally,
  } = useMedia();

  /** Holds the setInterval id for the post-upload enrichment poll. */
  const enrichmentPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Tracks how many poll attempts have fired for the current upload batch. */
  const enrichmentPollAttemptsRef = useRef(0);

  const { albums, fetchAlbums } = useAlbums();

  const [tags, setTags] = useState<TagItem[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [filterType, setFilterType] = useState<MediaType | ''>('');
  const [filterClassification, setFilterClassification] = useState<MediaClassification | ''>('');
  const [filterFavorite, setFilterFavorite] = useState(false);
  const [filterAlbum, setFilterAlbum] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [sortBy, setSortBy] = useState<'capturedAt' | 'importedAt' | 'createdAt'>('capturedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  // Location drill-down
  const [filterCountry, setFilterCountry] = useState('');
  const [filterRegion, setFilterRegion] = useState('');
  const [filterLocality, setFilterLocality] = useState('');
  const [locationSearch, setLocationSearch] = useState('');

  // Drawer / dialog
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  // Export menu
  const [exportAnchorEl, setExportAnchorEl] = useState<null | HTMLElement>(null);
  const exportMenuOpen = Boolean(exportAnchorEl);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const geoFacets = useMemo(() => deriveGeoFacets(items), [items]);

  const buildParams = useCallback((): MediaQueryParams => {
    const params: MediaQueryParams = {
      page,
      pageSize: 20,
      sortBy,
      sortOrder,
    };
    if (filterType) params.type = filterType;
    if (filterClassification) params.classification = filterClassification;
    if (filterFavorite) params.favorite = true;
    if (filterAlbum) params.albumId = filterAlbum;
    if (filterDateFrom) params.capturedAtFrom = new Date(filterDateFrom).toISOString();
    if (filterDateTo) params.capturedAtTo = new Date(filterDateTo).toISOString();
    if (selectedTags.length === 1) params.tag = selectedTags[0];
    if (filterCountry) params.country = filterCountry;
    if (filterRegion) params.region = filterRegion;
    if (filterLocality) params.locality = filterLocality;
    if (locationSearch) params.location = locationSearch;
    return params;
  }, [
    page,
    sortBy,
    sortOrder,
    filterType,
    filterClassification,
    filterFavorite,
    filterAlbum,
    filterDateFrom,
    filterDateTo,
    selectedTags,
    filterCountry,
    filterRegion,
    filterLocality,
    locationSearch,
  ]);

  // Load data on mount and when filters change.
  // Also stop any running enrichment poll so it doesn't fight a user-initiated refetch.
  useEffect(() => {
    if (enrichmentPollRef.current !== null) {
      clearInterval(enrichmentPollRef.current);
      enrichmentPollRef.current = null;
    }
    void fetchMedia(buildParams());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    page,
    filterType,
    filterClassification,
    filterFavorite,
    filterAlbum,
    filterDateFrom,
    filterDateTo,
    selectedTags,
    filterCountry,
    filterRegion,
    filterLocality,
    locationSearch,
    sortBy,
    sortOrder,
  ]);

  useEffect(() => {
    void fetchAlbums({ pageSize: 100 });
    listTags()
      .then(setTags)
      .catch(() => setTags([]));
  }, [fetchAlbums]);

  // Clear any running enrichment poll on unmount so it never leaks.
  useEffect(() => {
    return () => {
      if (enrichmentPollRef.current !== null) {
        clearInterval(enrichmentPollRef.current);
        enrichmentPollRef.current = null;
      }
    };
  }, []);

  const handleToggleTag = useCallback((tagName: string) => {
    setSelectedTags((prev) =>
      prev.includes(tagName)
        ? prev.filter((t) => t !== tagName)
        : [...prev, tagName],
    );
    setPage(1);
  }, []);

  const handleSelectItem = useCallback((item: MediaItem) => {
    setSelectedItem(item);
    setDrawerOpen(true);
  }, []);

  const handleItemUpdated = useCallback(
    (updated: MediaItem) => {
      updateItemLocally(updated.id, updated);
      setSelectedItem(updated);
    },
    [updateItemLocally],
  );

  const handleToggleFavorite = useCallback(
    async (item: MediaItem) => {
      try {
        await patchMedia(item.id, { favorite: !item.favorite });
        if (selectedItem?.id === item.id) {
          setSelectedItem((prev) =>
            prev ? { ...prev, favorite: !prev.favorite } : prev,
          );
        }
      } catch {
        // Ignore — error already set by hook
      }
    },
    [patchMedia, selectedItem],
  );

  const handleUploadSuccess = useCallback(() => {
    setUploadOpen(false);
    setPage(1);

    // Cancel any previous enrichment poll before starting a new one.
    if (enrichmentPollRef.current !== null) {
      clearInterval(enrichmentPollRef.current);
      enrichmentPollRef.current = null;
    }
    enrichmentPollAttemptsRef.current = 0;

    // Immediate refetch so the new item appears right away.
    void fetchMedia(buildParams());

    // Bounded background poll: re-fetches every ENRICHMENT_POLL_INTERVAL_MS until
    // all photos have thumbnails or ENRICHMENT_POLL_MAX_ATTEMPTS is reached.
    enrichmentPollRef.current = setInterval(() => {
      enrichmentPollAttemptsRef.current += 1;

      void fetchMedia(buildParams()).then((loadedItems) => {
        const done =
          allItemsEnriched(loadedItems) ||
          enrichmentPollAttemptsRef.current >= ENRICHMENT_POLL_MAX_ATTEMPTS;

        if (done && enrichmentPollRef.current !== null) {
          clearInterval(enrichmentPollRef.current);
          enrichmentPollRef.current = null;
        }
      });
    }, ENRICHMENT_POLL_INTERVAL_MS);
  }, [fetchMedia, buildParams]);

  const handleCountrySelect = useCallback((country: string) => {
    setFilterCountry(country);
    setFilterRegion('');
    setFilterLocality('');
    setPage(1);
  }, []);

  const handleRegionSelect = useCallback((region: string) => {
    setFilterRegion(region);
    setFilterLocality('');
    setPage(1);
  }, []);

  const handleLocalitySelect = useCallback((locality: string) => {
    setFilterLocality(locality);
    setPage(1);
  }, []);

  const handleClearLocation = useCallback(() => {
    setFilterCountry('');
    setFilterRegion('');
    setFilterLocality('');
    setLocationSearch('');
    setPage(1);
  }, []);

  const handleExport = useCallback(
    async (format: 'json' | 'csv') => {
      setExportAnchorEl(null);
      setExportError(null);
      setExportLoading(true);

      // Only forward the filters the export endpoint supports (type + date range)
      const filters: ExportFilters = {};
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
    [filterType, filterDateFrom, filterDateTo],
  );

  const grouped = useMemo(() => groupByYearMonth(items), [items]);

  const availableRegions = filterCountry
    ? Array.from(geoFacets.regionsByCountry.get(filterCountry) ?? []).sort()
    : [];

  const availableCities =
    filterCountry && filterRegion
      ? Array.from(
          geoFacets.citiesByRegion.get(`${filterCountry}::${filterRegion}`) ?? [],
        ).sort()
      : [];

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

        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
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
            startIcon={<FilterIcon />}
            onClick={() => setShowFilters((prev) => !prev)}
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
                    setPage(1);
                  }}
                >
                  <MenuItem value="">All types</MenuItem>
                  <MenuItem value="photo">Photos</MenuItem>
                  <MenuItem value="video">Videos</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            {/* Classification filter */}
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <FormControl size="small" fullWidth>
                <InputLabel>Classification</InputLabel>
                <Select
                  label="Classification"
                  value={filterClassification}
                  onChange={(e) => {
                    setFilterClassification(e.target.value as MediaClassification | '');
                    setPage(1);
                  }}
                >
                  <MenuItem value="">All</MenuItem>
                  <MenuItem value="memory">Memory</MenuItem>
                  <MenuItem value="low_value">Low Value</MenuItem>
                  <MenuItem value="unreviewed">Unreviewed</MenuItem>
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
                    setPage(1);
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
                    setPage(1);
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
                  setPage(1);
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
                  setPage(1);
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
                  setPage(1);
                }}
              >
                <ToggleButton value="all">All</ToggleButton>
                <ToggleButton value="favorites">
                  <StarIcon sx={{ mr: 0.5, fontSize: 16 }} /> Favorites only
                </ToggleButton>
              </ToggleButtonGroup>
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
                    setPage(1);
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
          </Grid>
        </Paper>
      </Collapse>

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

      {/* Error state */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
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

      {/* Loading */}
      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      )}

      {/* Empty state */}
      {!isLoading && items.length === 0 && !error && (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <PhotoLibraryIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" color="text.secondary">
            No media found
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Upload photos or videos to get started
          </Typography>
          <Button
            variant="contained"
            sx={{ mt: 2 }}
            startIcon={<UploadIcon />}
            onClick={() => setUploadOpen(true)}
          >
            Upload Media
          </Button>
        </Box>
      )}

      {/* Grid grouped by month */}
      {!isLoading && items.length > 0 && (
        <>
          {grouped.map((group) => (
            <Box key={group.key} sx={{ mb: 3 }}>
              <Typography
                variant="subtitle2"
                color="text.secondary"
                sx={{
                  mb: 1,
                  pb: 0.5,
                  borderBottom: `1px solid ${theme.palette.divider}`,
                }}
              >
                {group.label}
              </Typography>

              {/* Responsive grid using MUI Grid v2 */}
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: {
                    xs: '1fr',
                    md: 'repeat(2, 1fr)',
                    lg: 'repeat(4, 1fr)',
                  },
                  gap: 1,
                }}
              >
                {group.items.map((item) => (
                  <MediaTile
                    key={item.id}
                    item={item}
                    colCount={colCount}
                    onSelect={handleSelectItem}
                    onToggleFavorite={handleToggleFavorite}
                  />
                ))}
              </Box>
            </Box>
          ))}

          {/* Pagination */}
          {meta && meta.totalPages > 1 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
              <Pagination
                count={meta.totalPages}
                page={page}
                onChange={(_, val) => setPage(val)}
                color="primary"
              />
            </Box>
          )}
        </>
      )}

      {/* Upload FAB */}
      <Fab
        color="primary"
        aria-label="Upload media"
        onClick={() => setUploadOpen(true)}
        sx={{ position: 'fixed', bottom: 24, right: 24 }}
      >
        <UploadIcon />
      </Fab>

      {/* Detail drawer */}
      <MediaDetailDrawer
        item={selectedItem}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onItemUpdated={handleItemUpdated}
      />

      {/* Upload dialog */}
      <MediaUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={handleUploadSuccess}
      />
    </Box>
  );
}
