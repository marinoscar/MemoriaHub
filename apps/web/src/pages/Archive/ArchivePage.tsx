import { useRef, useState, useCallback, useMemo } from 'react';
import {
  Box,
  Typography,
  Alert,
  Skeleton,
  CircularProgress,
  Snackbar,
  IconButton,
  Tooltip,
  Stack,
} from '@mui/material';
import {
  Archive as ArchiveIcon,
  CheckBox as CheckBoxIcon,
  CheckBoxOutlineBlank as CheckBoxOutlineBlankIcon,
  Close as CloseIcon,
  SelectAll as SelectAllIcon,
} from '@mui/icons-material';
import { useCircle } from '../../hooks/useCircle';
import { useInfiniteArchived } from '../../hooks/useInfiniteArchived';
import { useIntersectionObserver } from '../../hooks/useIntersectionObserver';
import { groupByDay } from '../../utils/groupByDay';
import { MediaDetailDrawer } from '../../components/media/MediaDetailDrawer';
import { MediaLightbox } from '../../components/media/MediaLightbox';
import { ArchiveBulkToolbar } from '../../components/media/ArchiveBulkToolbar';
import type { MediaItem } from '../../types/media';

export default function ArchivePage() {
  const { activeCircleId, activeCircleRole } = useCircle();

  const {
    items,
    loadMore,
    hasMore,
    isLoading,
    error,
    reset,
  } = useInfiniteArchived(activeCircleId ?? '', 50, Boolean(activeCircleId));

  const sentinelRef = useRef<HTMLDivElement>(null);
  useIntersectionObserver(sentinelRef, loadMore, {
    rootMargin: '300px',
    disabled: !hasMore || isLoading || !activeCircleId,
  });

  // Optimistic patches
  const [localPatches, setLocalPatches] = useState<Record<string, Partial<MediaItem>>>({});
  const mergedItems = useMemo(
    () => items.map((it) => (localPatches[it.id] ? { ...it, ...localPatches[it.id] } : it)),
    [items, localPatches],
  );
  const grouped = useMemo(() => groupByDay(mergedItems), [mergedItems]);

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);

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
    setSelected(new Set(mergedItems.map((it) => it.id)));
  }, [mergedItems]);

  // Lightbox + drawer
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [detailItem, setDetailItem] = useState<MediaItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleItemUpdated = useCallback((updated: MediaItem) => {
    setLocalPatches((prev) => ({ ...prev, [updated.id]: updated }));
  }, []);

  // Snackbar
  const [snackbar, setSnackbar] = useState<{ message: string; severity: 'success' | 'error' } | null>(null);

  const handleBulkSuccess = useCallback(
    (message: string) => {
      setSnackbar({ message, severity: 'success' });
      setSelected(new Set());
      setSelectionMode(false);
      setLocalPatches({});
      reset();
    },
    [reset],
  );

  const handleBulkError = useCallback((message: string) => {
    setSnackbar({ message, severity: 'error' });
  }, []);

  if (!activeCircleId) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography color="text.secondary">Select a circle to view archived items.</Typography>
      </Box>
    );
  }

  const showFirstLoad = isLoading && items.length === 0;
  const showEmpty = !isLoading && !error && mergedItems.length === 0;
  const anySelected = selected.size > 0;

  return (
    <Box sx={{ minHeight: 0 }}>
      {/* Page header */}
      <Box sx={{ px: { xs: 2, sm: 3 }, pt: { xs: 2, sm: 3 }, pb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <ArchiveIcon sx={{ color: 'text.secondary' }} />
          <Typography variant="h5" component="h1">
            Archive
          </Typography>
        </Box>
        <Typography variant="body2" color="text.secondary">
          Photos hidden from your main library. They still appear in search results.
        </Typography>
      </Box>

      {/* Error */}
      {error && (
        <Box sx={{ px: { xs: 2, sm: 3 }, pb: 2 }}>
          <Alert severity="error">{error}</Alert>
        </Box>
      )}

      {/* Bulk toolbar */}
      {anySelected && (
        <ArchiveBulkToolbar
          selected={selected}
          circleId={activeCircleId}
          activeCircleRole={activeCircleRole}
          onClear={handleClearSelection}
          onSelectAll={handleSelectAll}
          onSuccess={handleBulkSuccess}
          onError={handleBulkError}
        />
      )}

      {/* First-page loading skeletons */}
      {showFirstLoad && (
        <Box sx={{ px: { xs: 1, sm: 2 } }}>
          <Skeleton variant="text" width={180} height={24} sx={{ mb: 1 }} />
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'repeat(3, 1fr)', sm: 'repeat(4, 1fr)', md: 'repeat(6, 1fr)' },
              gap: '2px',
            }}
          >
            {Array.from({ length: 18 }).map((_, i) => (
              <Skeleton key={i} variant="rectangular" sx={{ aspectRatio: '1', borderRadius: 0.5 }} />
            ))}
          </Box>
        </Box>
      )}

      {/* Empty state */}
      {showEmpty && (
        <Box sx={{ textAlign: 'center', py: 10, px: 3 }}>
          <ArchiveIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" color="text.secondary">
            Archive is empty
          </Typography>
          <Typography variant="body2" color="text.disabled" sx={{ mt: 1 }}>
            Items you archive will appear here
          </Typography>
        </Box>
      )}

      {/* Day-grouped grid */}
      {!showFirstLoad && mergedItems.length > 0 && (
        <Box sx={{ px: { xs: 1, sm: 2 }, pt: { xs: 1, sm: 2 } }}>
          {grouped.map((group) => (
            <Box key={group.key} sx={{ mb: 3 }}>
              {/* Day header */}
              <Box
                sx={{
                  position: 'sticky',
                  top: 64,
                  zIndex: 2,
                  backgroundColor: 'background.default',
                  pb: 0.5,
                  pt: 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                }}
              >
                <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                  {group.label}
                </Typography>
                <Typography variant="caption" color="text.disabled">
                  {group.items.length} item{group.items.length !== 1 ? 's' : ''}
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ ml: 'auto' }}>
                  <Tooltip title={selectionMode ? 'Exit selection' : 'Select'}>
                    <IconButton
                      size="small"
                      onClick={() => setSelectionMode((v) => !v)}
                      aria-label={selectionMode ? 'Exit selection mode' : 'Enter selection mode'}
                    >
                      {selectionMode ? <CloseIcon fontSize="small" /> : <CheckBoxOutlineBlankIcon fontSize="small" />}
                    </IconButton>
                  </Tooltip>
                  {selectionMode && (
                    <Tooltip title="Select all in this day">
                      <IconButton
                        size="small"
                        onClick={() => {
                          const ids = group.items.map((it) => it.id);
                          setSelected((prev) => {
                            const next = new Set(prev);
                            ids.forEach((id) => next.add(id));
                            return next;
                          });
                        }}
                        aria-label="Select all in this day"
                      >
                        <SelectAllIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Stack>
              </Box>

              {/* Grid */}
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: 'repeat(3, 1fr)', sm: 'repeat(4, 1fr)', md: 'repeat(6, 1fr)' },
                  gap: '2px',
                }}
              >
                {group.items.map((item) => {
                  const globalIdx = mergedItems.indexOf(item);
                  const isSelected = selected.has(item.id);
                  return (
                    <Box
                      key={item.id}
                      onClick={() => {
                        if (selectionMode || anySelected) {
                          handleToggleSelect(item.id);
                        } else {
                          setLightboxIndex(globalIdx);
                        }
                      }}
                      sx={{
                        position: 'relative',
                        cursor: 'pointer',
                        overflow: 'hidden',
                        borderRadius: 0.5,
                        aspectRatio: '1',
                        backgroundColor: 'grey.900',
                        outline: isSelected ? '2px solid' : 'none',
                        outlineColor: 'primary.main',
                        outlineOffset: '-2px',
                        opacity: isSelected ? 0.85 : 1,
                        transition: 'outline 0.1s, opacity 0.1s',
                        '&:hover .arch-overlay': { opacity: 1 },
                      }}
                    >
                      {item.thumbnailUrl ? (
                        <Box
                          component="img"
                          src={item.thumbnailUrl}
                          alt={item.originalFilename}
                          sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        />
                      ) : (
                        <Box sx={{ width: '100%', height: '100%', bgcolor: 'grey.800' }} />
                      )}

                      {/* Selection overlay */}
                      <Box
                        className="arch-overlay"
                        sx={{
                          position: 'absolute',
                          top: 4,
                          left: 4,
                          zIndex: 2,
                          opacity: selectionMode || anySelected || isSelected ? 1 : 0,
                          transition: 'opacity 0.15s',
                        }}
                      >
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleSelect(item.id);
                          }}
                          aria-label={isSelected ? 'Deselect item' : 'Select item'}
                          sx={{
                            color: isSelected ? 'primary.main' : 'white',
                            backgroundColor: 'rgba(0,0,0,0.4)',
                            '&:hover': { backgroundColor: 'rgba(0,0,0,0.6)' },
                            p: { xs: 0.5, sm: 0.25 },
                          }}
                        >
                          {isSelected ? (
                            <CheckBoxIcon fontSize="small" />
                          ) : (
                            <CheckBoxOutlineBlankIcon fontSize="small" />
                          )}
                        </IconButton>
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            </Box>
          ))}

          {/* Infinite scroll sentinel */}
          <div ref={sentinelRef} style={{ height: 1 }} />

          {/* Load-more spinner */}
          {isLoading && items.length > 0 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress size={28} />
            </Box>
          )}
        </Box>
      )}

      {/* Lightbox */}
      <MediaLightbox
        items={mergedItems}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onIndexChange={(i) => setLightboxIndex(i)}
        onOpenProperties={(item: MediaItem) => {
          setDetailItem(item);
          setDrawerOpen(true);
          setLightboxIndex(null);
        }}
      />

      {/* Detail drawer */}
      <MediaDetailDrawer
        item={detailItem}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onItemUpdated={handleItemUpdated}
      />

      {/* Snackbar */}
      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={4000}
        onClose={() => setSnackbar(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar(null)}
          severity={snackbar?.severity ?? 'success'}
          variant="filled"
          sx={{ width: '100%' }}
        >
          {snackbar?.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
