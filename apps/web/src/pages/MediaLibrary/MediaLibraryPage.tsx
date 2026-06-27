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
  ImageListItem,
  ImageListItemBar,
  IconButton,
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
  Badge,
  Button,
  Collapse,
  Pagination,
  useMediaQuery,
  ToggleButton,
  ToggleButtonGroup,
  Paper,
  Menu,
  Snackbar,
  Switch,
  FormControlLabel,
} from '@mui/material';
import {
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  FilterList as FilterIcon,
  Search as SearchIcon,
  FileDownload as ExportIcon,
  PhotoLibrary as PhotoLibraryIcon,
  PlayCircleOutlined as PlayCircleOutlinedIcon,
  CheckBox as CheckBoxIcon,
  CheckBoxOutlineBlank as CheckBoxOutlineBlankIcon,
  Checklist as ChecklistIcon,
  Person as PersonIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import { useSearchParams } from 'react-router-dom';
import { useMedia } from '../../hooks/useMedia';
import { useAlbums } from '../../hooks/useAlbums';
import { useCircle } from '../../hooks/useCircle';
import { listTags, exportMedia } from '../../services/media';
import type { ExportFilters } from '../../services/media';
import { MediaDetailDrawer } from '../../components/media/MediaDetailDrawer';
import { MediaLightbox } from '../../components/media/MediaLightbox';
import { BulkActionToolbar } from '../../components/media/BulkActionToolbar';
import { BulkLocationDialog } from '../../components/media/BulkLocationDialog';
import { BulkDateDialog } from '../../components/media/BulkDateDialog';
import { BulkTagsDialog } from '../../components/media/BulkTagsDialog';
import { AddToAlbumDialog } from '../../components/album/AddToAlbumDialog';
import type { MediaItem, MediaQueryParams, TagItem, MediaType } from '../../types/media';
import { PersonMultiSelect } from '../../components/search/PersonMultiSelect';

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
  isSelected: boolean;
  anySelected: boolean;
  onToggleSelect: (id: string) => void;
  selectionMode: boolean;
}

function MediaTile({ item, onSelect, onToggleFavorite, isSelected, anySelected, onToggleSelect, selectionMode }: MediaTileProps) {
  const theme = useTheme();
  const isMobileDevice = useMediaQuery(theme.breakpoints.down('sm'));
  const [imgError, setImgError] = useState(false);

  const thumbUrl = item.thumbnailUrl;

  return (
    <ImageListItem
      onClick={() => {
        if (selectionMode || anySelected) {
          onToggleSelect(item.id);
        } else {
          onSelect(item);
        }
      }}
      sx={{
        position: 'relative',
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
            alt={item.originalFilename}
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

      {/* Selection checkbox — shown on hover or when any item is selected; always visible on mobile */}
      <Box
        className="select-overlay"
        sx={{
          position: 'absolute',
          top: 4,
          left: 4,
          zIndex: 2,
          opacity: isMobileDevice || selectionMode || anySelected || isSelected ? 1 : 0,
          transition: 'opacity 0.15s',
          '.MuiImageListItem-root:hover &': { opacity: 1 },
        }}
      >
        <IconButton
          size="small"
          onClick={(e) => { e.stopPropagation(); onToggleSelect(item.id); }}
          aria-label={isSelected ? 'Deselect item' : 'Select item'}
          sx={{
            color: isSelected ? 'primary.main' : 'white',
            backgroundColor: 'rgba(0,0,0,0.4)',
            '&:hover': { backgroundColor: 'rgba(0,0,0,0.6)' },
            p: { xs: 0.5, sm: 0.25 },
          }}
        >
          {isSelected ? <CheckBoxIcon fontSize="small" /> : <CheckBoxOutlineBlankIcon fontSize="small" />}
        </IconButton>
      </Box>

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
              sx={{ color: item.favorite ? theme.palette.warning.main : 'white', p: { xs: 1, sm: 0.5 } }}
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
  const { activeCircle, activeCircleRole } = useCircle();

  const colCount = isXl || isLg ? 4 : isMd ? 2 : 1;

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

  const {
    items,
    meta,
    isLoading,
    error,
    fetchMedia,
    patchMedia,
    updateItemLocally,
  } = useMedia();

  const { albums, fetchAlbums } = useAlbums();

  const [tags, setTags] = useState<TagItem[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [filterType, setFilterType] = useState<MediaType | ''>((searchParams.get('type') as MediaType) || '');
  const [filterFavorite, setFilterFavorite] = useState(searchParams.get('favorite') === '1');
  const [filterAlbum, setFilterAlbum] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [sortBy, setSortBy] = useState<'capturedAt' | 'importedAt' | 'createdAt'>('capturedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [filterMissingGeo, setFilterMissingGeo] = useState<boolean>(searchParams.get('missingGeo') === '1');
  const [filterNoFaces, setFilterNoFaces] = useState<boolean>(searchParams.get('noFaces') === '1');
  const [filterCameraMake, setFilterCameraMake] = useState<string>(searchParams.get('cameraMake') || '');
  const [filterCameraModel, setFilterCameraModel] = useState<string>(searchParams.get('cameraModel') || '');
  const [filterDeviceName, setFilterDeviceName] = useState<string>(searchParams.get('sourceDeviceName') || '');

  // Selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [bulkLocationOpen, setBulkLocationOpen] = useState(false);
  const [bulkDateOpen, setBulkDateOpen] = useState(false);
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
  const [snackbar, setSnackbar] = useState<{ message: string; severity: 'success' | 'error' } | null>(null);

  // Multi-person filter
  const [peopleFilter, setPeopleFilter] = useState<{ ids: string[]; mode: 'any' | 'all' }>({ ids: [], mode: 'any' });

  // Location drill-down
  const [filterCountry, setFilterCountry] = useState('');
  const [filterRegion, setFilterRegion] = useState('');
  const [filterLocality, setFilterLocality] = useState('');
  const [locationSearch, setLocationSearch] = useState('');

  // Drawer / dialog
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Export menu
  const [exportAnchorEl, setExportAnchorEl] = useState<null | HTMLElement>(null);
  const exportMenuOpen = Boolean(exportAnchorEl);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Add to album dialog
  const [addToAlbumOpen, setAddToAlbumOpen] = useState(false);

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

  const buildParams = useCallback((): MediaQueryParams => {
    const params: MediaQueryParams = {
      page,
      pageSize: 20,
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
    page,
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

  // Load data on mount and when filters change.
  useEffect(() => {
    if (!activeCircle) return;
    void fetchMedia(buildParams());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeCircle,
    page,
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
    sortBy,
    sortOrder,
    filterMissingGeo,
    filterNoFaces,
    filterCameraMake,
    filterCameraModel,
    filterDeviceName,
    personId,
    peopleFilter,
  ]);

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
    setPage(1);
  }, []);

  const handleSelectItem = useCallback((item: MediaItem) => {
    const idx = items.indexOf(item);
    if (idx !== -1) setLightboxIndex(idx);
  }, [items]);

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

  const handleToggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelected(new Set());
    setSelectionMode(false);
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelected(new Set(items.map((item) => item.id)));
  }, [items]);

  const handleBulkSuccess = useCallback((message: string) => {
    setSnackbar({ message, severity: 'success' });
    setSelected(new Set());
    setSelectionMode(false);
    void fetchMedia(buildParams());
  }, [fetchMedia, buildParams]);

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
          {/* Select toggle button — touch-friendly multi-select */}
          {activeCircleRole !== 'viewer' && (
            <Button
              variant={selectionMode ? 'contained' : 'outlined'}
              startIcon={<ChecklistIcon />}
              onClick={() => {
                if (selectionMode) {
                  setSelectionMode(false);
                  setSelected(new Set());
                } else {
                  setSelectionMode(true);
                }
              }}
              aria-pressed={selectionMode}
              aria-label={selectionMode ? 'Exit selection mode' : 'Enter selection mode'}
              sx={{ minHeight: 44 }}
            >
              {selectionMode ? 'Done' : 'Select'}
            </Button>
          )}

          {/* Add to Album button */}
          {activeCircleRole !== 'viewer' && (
            <Button
              variant="outlined"
              startIcon={<PhotoLibraryIcon />}
              onClick={() => setAddToAlbumOpen(true)}
              sx={{ minHeight: 44 }}
            >
              Add to Album
            </Button>
          )}

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
                    setPage(1);
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
                onChange={(e) => { setFilterCameraMake(e.target.value); setPage(1); }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                label="Camera Model"
                size="small"
                fullWidth
                value={filterCameraModel}
                onChange={(e) => { setFilterCameraModel(e.target.value); setPage(1); }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <TextField
                label="Device Name"
                size="small"
                fullWidth
                value={filterDeviceName}
                onChange={(e) => { setFilterDeviceName(e.target.value); setPage(1); }}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 3 }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={filterMissingGeo}
                    onChange={(e) => { setFilterMissingGeo(e.target.checked); setPage(1); }}
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
                    onChange={(e) => { setFilterNoFaces(e.target.checked); setPage(1); }}
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
                  setPage(1);
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
                  onClick={() => { setPeopleFilter({ ids: [], mode: 'any' }); setPage(1); }}
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
            Upload photos or videos using the Upload button in the toolbar.
          </Typography>
        </Box>
      )}

      {/* Grid grouped by month */}
      {!isLoading && items.length > 0 && (
        <>
          {grouped.map((group) => (
            <Box key={group.key} sx={{ mb: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1, pb: 0.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
                <Typography variant="subtitle2" color="text.secondary">
                  {group.label}
                </Typography>
                <Stack direction="row" spacing={0.5}>
                  <Button
                    size="small"
                    variant="text"
                    sx={{ minWidth: 'auto', fontSize: '0.7rem', py: 0 }}
                    onClick={() => {
                      setSelected(prev => {
                        const next = new Set(prev);
                        group.items.forEach(item => next.add(item.id));
                        return next;
                      });
                    }}
                  >
                    Select all
                  </Button>
                  {group.items.some(item => selected.has(item.id)) && (
                    <Button
                      size="small"
                      variant="text"
                      sx={{ minWidth: 'auto', fontSize: '0.7rem', py: 0 }}
                      onClick={() => {
                        setSelected(prev => {
                          const next = new Set(prev);
                          group.items.forEach(item => next.delete(item.id));
                          return next;
                        });
                      }}
                    >
                      Clear
                    </Button>
                  )}
                </Stack>
              </Box>

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
                    isSelected={selected.has(item.id)}
                    anySelected={selected.size > 0}
                    onToggleSelect={handleToggleSelect}
                    selectionMode={selectionMode}
                  />
                ))}
              </Box>
            </Box>
          ))}

          {/* Pagination */}
          {meta && meta.totalPages > 1 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3, pb: 2 }}>
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

      {/* Detail drawer */}
      <MediaDetailDrawer
        item={selectedItem}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onItemUpdated={handleItemUpdated}
      />

      {/* Lightbox */}
      <MediaLightbox
        items={items}
        index={lightboxIndex}
        onIndexChange={(i) => {
          setLightboxIndex(i);
          setDrawerOpen(false);
        }}
        onClose={() => setLightboxIndex(null)}
        onOpenProperties={(item) => {
          setSelectedItem(item);
          setDrawerOpen(true);
        }}
        onItemUpdated={handleItemUpdated}
      />

      {/* Bulk action toolbar */}
      <BulkActionToolbar
        selected={selected}
        circleId={activeCircle.id}
        activeCircleRole={activeCircleRole}
        onClear={handleClearSelection}
        onSelectAll={handleSelectAll}
        onOpenLocation={() => setBulkLocationOpen(true)}
        onOpenDate={() => setBulkDateOpen(true)}
        onOpenTags={() => setBulkTagsOpen(true)}
        onOpenAlbum={() => setAddToAlbumOpen(true)}
        onSuccess={handleBulkSuccess}
        onError={(msg) => setSnackbar({ message: msg, severity: 'error' })}
      />

      {/* Bulk location dialog */}
      <BulkLocationDialog
        open={bulkLocationOpen}
        onClose={() => setBulkLocationOpen(false)}
        circleId={activeCircle.id}
        ids={Array.from(selected)}
        onSuccess={(msg) => { setBulkLocationOpen(false); handleBulkSuccess(msg); }}
      />

      {/* Bulk date dialog */}
      <BulkDateDialog
        open={bulkDateOpen}
        onClose={() => setBulkDateOpen(false)}
        circleId={activeCircle.id}
        ids={Array.from(selected)}
        onSuccess={(msg) => { setBulkDateOpen(false); handleBulkSuccess(msg); }}
      />

      {/* Bulk tags dialog */}
      <BulkTagsDialog
        open={bulkTagsOpen}
        onClose={() => setBulkTagsOpen(false)}
        circleId={activeCircle.id}
        ids={Array.from(selected)}
        onSuccess={(msg) => { setBulkTagsOpen(false); handleBulkSuccess(msg); }}
      />

      {/* Add to Album dialog */}
      {activeCircle && (
        <AddToAlbumDialog
          open={addToAlbumOpen}
          onClose={() => setAddToAlbumOpen(false)}
          circleId={activeCircle.id}
          selectedIds={Array.from(selected)}
          filters={(() => {
            const p = buildParams();
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { page: _p, pageSize: _ps, sortBy: _sb, sortOrder: _so, ...rest } = p;
            return rest;
          })()}
          matchingCount={meta?.totalItems ?? 0}
          onSuccess={(msg) => {
            setAddToAlbumOpen(false);
            setSnackbar({ message: msg, severity: 'success' });
            setSelected(new Set());
            setSelectionMode(false);
          }}
          onError={(msg) => {
            setAddToAlbumOpen(false);
            setSnackbar({ message: msg, severity: 'error' });
          }}
        />
      )}

      {/* Snackbar */}
      <Snackbar
        open={snackbar !== null}
        autoHideDuration={4000}
        onClose={() => setSnackbar(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar(null)}
          severity={snackbar?.severity ?? 'success'}
          sx={{ width: '100%' }}
        >
          {snackbar?.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
