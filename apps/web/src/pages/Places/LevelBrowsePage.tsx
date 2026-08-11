/**
 * LevelBrowsePage — full-list responsive grid for a single location level.
 *
 * Parameterized by `level` (countries | regions | cities); serves the
 * /places/countries, /places/regions and /places/cities routes. Mirrors the
 * TagsBrowsePage grid template (1:1 tiles, cover-or-icon fallback, name+count,
 * skeletons, empty state, no-circle guard). Tiles navigate to the media
 * library filtered by the tapped location.
 *
 * Select mode (issue #407) — merge in context. This page is exactly where a
 * user SEES three Heredia tiles side by side, so it offers a select-many-then
 * merge flow instead of forcing them into the admin page to search and add each
 * member one at a time. It is rendered ONLY for a user holding
 * `geo_settings:write`; without that permission the page is byte-identical to
 * what it was before — no toggle, no checkbox affordance, no layout shift.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Paper,
  Skeleton,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Place as PlaceIcon,
  RadioButtonUnchecked as UncheckedIcon,
} from '@mui/icons-material';
import { useCircle } from '../../hooks/useCircle';
import { usePermissions } from '../../hooks/usePermissions';
import { getExploreLocationLevel } from '../../services/media';
import type { ExploreLocationItem } from '../../services/media';
import MergeLocationsDialog from '../../components/locations/MergeLocationsDialog';
import type { MergeLocationCandidate } from '../../components/locations/MergeLocationsDialog';
import { mergedGroupName } from '../../services/locationGroups';
import type { LocationGroupLevel } from '../../services/locationGroups';
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
  /** Tier this level maps to in the Location Grouping model. */
  groupLevel: LocationGroupLevel;
  /**
   * Country scope submitted when merging from this tier, or `null` to derive
   * it from the selected tiles.
   *
   * `getExploreLocationLevel` deliberately drops `countryCode` for regions and
   * cities — those tiers are aggregated ACROSS countries — so only the country
   * tier can carry a real code. Regions and cities therefore submit `''`, the
   * deliberate UNSCOPED sentinel meaning "applies in every country", which is
   * also what the tile cover lookup resolves for those tiers.
   */
  mergeCountryCode: string | null;
}

const LEVEL_CONFIG: Record<Level, LevelConfig> = {
  countries: {
    title: 'Countries',
    param: 'country',
    emptyTitle: 'No countries yet',
    emptyBody: 'Add location data to your photos to see them grouped by country.',
    guard: 'Select a circle to view countries.',
    groupLevel: 'country',
    mergeCountryCode: null,
  },
  regions: {
    title: 'Regions',
    param: 'region',
    emptyTitle: 'No regions yet',
    emptyBody: 'Add location data to your photos to see them grouped by region.',
    guard: 'Select a circle to view regions.',
    groupLevel: 'region',
    mergeCountryCode: '',
  },
  cities: {
    title: 'Cities',
    param: 'locality',
    emptyTitle: 'No cities yet',
    emptyBody: 'Add location data to your photos to see them grouped by city.',
    guard: 'Select a circle to view cities.',
    groupLevel: 'locality',
    mergeCountryCode: '',
  },
};

// ---------------------------------------------------------------------------
// LevelBrowsePage
// ---------------------------------------------------------------------------

export default function LevelBrowsePage({ level }: { level: Level }) {
  const navigate = useNavigate();
  const { activeCircle } = useCircle();
  const { hasPermission } = usePermissions();

  const config = LEVEL_CONFIG[level];

  /** Merge is a global geo configuration change — Admin-only, `geo_settings:write`. */
  const canMerge = hasPermission('geo_settings:write');

  const [items, setItems] = useState<ExploreLocationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ---- Select mode (only ever entered by a `geo_settings:write` holder) ----
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mergeOpen, setMergeOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!activeCircle) return;
    setLoading(true);
    setFetchError(null);
    getExploreLocationLevel(activeCircle.id, level)
      .then((data) => setItems(data))
      .catch(() => setFetchError(`Failed to load ${config.title.toLowerCase()}.`))
      .finally(() => setLoading(false));
  }, [activeCircle, level, config.title, reloadToken]);

  // Switching tier drops the selection: a country tile is not a city tile, so
  // carrying ticks across levels would be nonsense.
  useEffect(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, [level]);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  const toggleSelected = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  /**
   * The tile's DISPLAYED name is the canonical value; for an ungrouped value
   * canonical equals raw, so it is the right member value to submit. A tile
   * that is already a group comes back as a 409 the dialog surfaces.
   */
  const selectedCandidates = useMemo<MergeLocationCandidate[]>(
    () =>
      items
        .filter((item) => selected.has(item.name))
        .map((item) => ({
          value: item.name,
          itemCount: item.count,
          countryCode: item.countryCode ?? null,
        })),
    [items, selected],
  );

  const selectedPhotoCount = useMemo(
    () => selectedCandidates.reduce((sum, c) => sum + c.itemCount, 0),
    [selectedCandidates],
  );

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
      {canMerge ? (
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 3, minWidth: 0 }}
        >
          <Typography variant="h5" component="h1" sx={{ minWidth: 0 }}>
            {config.title}
          </Typography>
          <Button
            size="small"
            variant={selectMode ? 'contained' : 'outlined'}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            sx={{ flexShrink: 0 }}
          >
            {selectMode ? 'Done' : 'Select'}
          </Button>
        </Stack>
      ) : (
        <Typography variant="h5" component="h1" sx={{ mb: 3 }}>
          {config.title}
        </Typography>
      )}

      {/* Selection bar */}
      {selectMode && (
        <Paper
          variant="outlined"
          sx={{ p: 1.5, mb: 2, minWidth: 0 }}
          data-testid="location-selection-bar"
        >
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', minWidth: 0 }}
          >
            <Typography variant="body2" sx={{ minWidth: 0 }}>
              {selected.size} selected · {selectedPhotoCount.toLocaleString()} photos
            </Typography>
            <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
              <Button
                size="small"
                variant="contained"
                disabled={selected.size === 0}
                onClick={() => setMergeOpen(true)}
              >
                Merge…
              </Button>
              <Button size="small" onClick={exitSelectMode}>
                Cancel
              </Button>
            </Stack>
          </Stack>
        </Paper>
      )}

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
            const isSelected = selected.has(item.name);
            const go = () =>
              selectMode ? toggleSelected(item.name) : navigate(locationHref(config.param, item.name));
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
                role={selectMode ? 'checkbox' : 'button'}
                aria-checked={selectMode ? isSelected : undefined}
                aria-label={
                  selectMode ? `Select ${item.name}` : `Browse photos from ${item.name}`
                }
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

                  {/* Selection overlay — only ever rendered in select mode, so
                      a user without geo_settings:write sees the original tree. */}
                  {selectMode && (
                    <>
                      <Box
                        sx={{
                          position: 'absolute',
                          inset: 0,
                          bgcolor: isSelected ? 'rgba(0,0,0,0.35)' : 'transparent',
                          transition: 'background-color 120ms',
                        }}
                      />
                      {isSelected ? (
                        <CheckCircleIcon
                          sx={{
                            position: 'absolute',
                            top: 4,
                            left: 4,
                            color: 'primary.main',
                            bgcolor: 'background.paper',
                            borderRadius: '50%',
                            fontSize: 20,
                          }}
                        />
                      ) : (
                        <UncheckedIcon
                          sx={{
                            position: 'absolute',
                            top: 4,
                            left: 4,
                            color: 'common.white',
                            fontSize: 20,
                            filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.6))',
                          }}
                        />
                      )}
                    </>
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

      {/* Merge dialog — mounted only for a permitted user in select mode. */}
      {canMerge && (
        <MergeLocationsDialog
          open={mergeOpen}
          level={config.groupLevel}
          selection={selectedCandidates}
          forcedCountryCode={config.mergeCountryCode}
          onClose={() => setMergeOpen(false)}
          onMerged={(result) => {
            exitSelectMode();
            setSuccessMessage(
              `Merged into "${mergedGroupName(result)}". A rebuild is queued — names update here once it finishes.`,
            );
            setReloadToken((t) => t + 1);
          }}
        />
      )}

      <Snackbar
        open={!!successMessage}
        autoHideDuration={6000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage}
      />
    </Box>
  );
}
