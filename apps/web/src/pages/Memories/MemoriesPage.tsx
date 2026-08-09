import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Link,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  AutoAwesomeMotion as AutoAwesomeMotionIcon,
  Favorite as FavoriteIcon,
  FavoriteBorder as FavoriteBorderIcon,
  MoreVert as MoreVertIcon,
} from '@mui/icons-material';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { useCircleRole } from '../../hooks/useCircleRole';
import { useIntersectionObserver } from '../../hooks/useIntersectionObserver';
import { useLongPress } from '../../hooks/useLongPress';
import { useMemories } from '../../hooks/useMemories';
import { useMemoriesEnabled } from '../../hooks/useMemoriesEnabled';
import { useMemoryActions } from '../../hooks/useMemoryActions';
import { usePermissions } from '../../hooks/usePermissions';
import { DeleteMemoryDialog } from '../../components/memories/DeleteMemoryDialog';
import { MemoryActionMenu } from '../../components/memories/MemoryActionMenu';
import { MemoryCard, MemoryCardSkeleton } from '../../components/memories/MemoryCard';
import {
  formatMemoryMonth,
  memoryMonthKey,
} from '../../components/memories/memoryFormat';
import {
  MEMORY_FILTER_TYPES,
  memoryTypeMeta,
} from '../../components/memories/memoryTypeMeta';
import { saveMemoryAsAlbum } from '../../services/memories';
import type { MemoryCard as MemoryCardDto, MemoryType } from '../../types/memories';

// ---------------------------------------------------------------------------
// URL-driven filter state.
//
// `?type=`, `?year=` and `?favorite=` ARE the page's state — a filtered view is
// shareable and survives a reload, and the back button steps through filter
// changes. Every value read out of the URL is coerced against the values the
// API actually accepts (the `parseSortBy` pattern from BurstsPage), because a
// hand-edited query string is untrusted input, not a typed object.
// ---------------------------------------------------------------------------

function parseType(raw: string | null): MemoryType | undefined {
  return MEMORY_FILTER_TYPES.includes(raw as MemoryType)
    ? (raw as MemoryType)
    : undefined;
}

function parseYear(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1900 || value > 3000) return undefined;
  return value;
}

/** Years offered in the dropdown: this year back through 1990. */
function buildYearOptions(): number[] {
  const now = new Date().getFullYear();
  const years: number[] = [];
  for (let y = now; y >= 1990; y -= 1) years.push(y);
  return years;
}

/** `trip` and `year_in_review` earn a two-column tile — visual rhythm, not uniform tiles. */
function isWideType(type: MemoryType): boolean {
  return type === 'trip' || type === 'year_in_review';
}

interface MenuTarget {
  memory: MemoryCardDto;
  anchorEl: HTMLElement | null;
  anchorPosition: { top: number; left: number } | null;
}

/**
 * The `/memories` hub (epic #300, issue #309) — browse every memory ever
 * created for the active circle, filter it, favorite it, hide it, delete it.
 *
 * Feature-gated strict-true on `features.memories`: with the flag off (the
 * default) the route still resolves — a bookmark must not 404 — but nothing is
 * fetched and the page says the feature is off rather than showing a broken
 * empty grid.
 */
export default function MemoriesPage() {
  const navigate = useNavigate();
  const { activeCircle, activeCircleId } = useCircle();
  const { isCollaborator } = useCircleRole();
  const { isAdmin } = usePermissions();
  const enabled = useMemoriesEnabled();
  const [searchParams, setSearchParams] = useSearchParams();

  const type = parseType(searchParams.get('type'));
  const year = parseYear(searchParams.get('year'));
  const favorite = searchParams.get('favorite') === 'true';

  // Memoized so `useMemories`' query key is stable across renders that changed
  // nothing — otherwise every render would look like a new filter.
  const filters = useMemo(
    () => ({ type, year, favorite: favorite || undefined }),
    [type, year, favorite],
  );

  const {
    items,
    hasMore,
    isLoading,
    isInitialLoading,
    error,
    loadMore,
    patchMyState,
    removeItem,
    restoreItem,
  } = useMemories(activeCircleId, filters, enabled === true);

  const actions = useMemoryActions({ patchMyState, removeItem, restoreItem });

  const [menuTarget, setMenuTarget] = useState<MenuTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemoryCardDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [savingAlbum, setSavingAlbum] = useState(false);
  const [toast, setToast] = useState<{ message: string; albumId?: string } | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useIntersectionObserver(sentinelRef, loadMore, {
    disabled: !hasMore || isLoading,
    rootMargin: '400px',
  });

  const setFilter = useCallback(
    (key: 'type' | 'year' | 'favorite', value: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (value === null) next.delete(key);
      else next.set(key, value);
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  const openMemory = useCallback(
    (memory: MemoryCardDto) => {
      actions.markSeen(memory.id);
      navigate(`/memories/${memory.id}`);
    },
    [actions, navigate],
  );

  const closeMenu = useCallback(() => setMenuTarget(null), []);

  const handleSaveAsAlbum = useCallback(async (memory: MemoryCardDto) => {
    setSavingAlbum(true);
    try {
      const result = await saveMemoryAsAlbum(memory.id);
      setToast({ message: 'Saved as an album', albumId: result.albumId });
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Could not save this album',
      });
    } finally {
      setSavingAlbum(false);
    }
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const ok = await actions.remove(deleteTarget.id);
    setDeleting(false);
    setDeleteTarget(null);
    if (ok) setToast({ message: 'Memory deleted for everyone in the circle' });
  }, [actions, deleteTarget]);

  // ---------------------------------------------------------------------------
  // Month grouping. Keyed on `generatedAt` (when curation created the memory),
  // NOT on the period it covers — the list is ordered newest-generated-first,
  // so grouping by anything else would produce headers that repeat as the user
  // scrolls. The key is `YYYY-MM` so two Augusts never collide by label.
  // ---------------------------------------------------------------------------
  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; items: MemoryCardDto[] }> = [];
    for (const memory of items) {
      const key = memoryMonthKey(memory.generatedAt);
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(memory);
      else out.push({ key, label: formatMemoryMonth(memory.generatedAt), items: [memory] });
    }
    return out;
  }, [items]);

  const filtersActive = Boolean(type || year || favorite);

  // While the flags are still resolving the list hook is disabled, so `items`
  // is legitimately empty — showing the "your memories will appear here" state
  // then would flash a wrong answer before the first request has even been
  // allowed to fire. Treat it as loading instead.
  const flagsResolving = enabled === null;
  const showSkeletons = flagsResolving || isInitialLoading;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (enabled === false) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">
          Memories are turned off for this installation.
          {isAdmin && (
            <>
              {' '}
              An admin can enable them in{' '}
              <Link component={RouterLink} to="/admin/settings/memories" underline="always">
                Memories settings
              </Link>
              .
            </>
          )}
        </Alert>
      </Box>
    );
  }

  if (!activeCircle && enabled !== null) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">
          Select a circle to see its memories.{' '}
          <Link component={RouterLink} to="/circles" underline="always">
            Go to Circles
          </Link>
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <AutoAwesomeMotionIcon color="primary" />
        <Typography variant="h4" component="h1">
          Memories
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Every moment MemoriaHub has brought back for {activeCircle?.name}.
      </Typography>

      {/* Filters */}
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 3 }}
        role="group"
        aria-label="Filter memories"
      >
        <Chip
          label="All"
          size="small"
          color={type ? 'default' : 'primary'}
          variant={type ? 'outlined' : 'filled'}
          onClick={() => setFilter('type', null)}
          aria-pressed={!type}
        />
        {MEMORY_FILTER_TYPES.map((value) => {
          const selected = type === value;
          return (
            <Chip
              key={value}
              label={memoryTypeMeta(value).filterLabel}
              size="small"
              color={selected ? 'primary' : 'default'}
              variant={selected ? 'filled' : 'outlined'}
              onClick={() => setFilter('type', selected ? null : value)}
              aria-pressed={selected}
            />
          );
        })}

        <TextField
          select
          size="small"
          label="Year"
          value={year ?? ''}
          onChange={(e) => setFilter('year', e.target.value === '' ? null : e.target.value)}
          sx={{ minWidth: 120 }}
        >
          <MenuItem value="">All years</MenuItem>
          {buildYearOptions().map((y) => (
            <MenuItem key={y} value={String(y)}>
              {y}
            </MenuItem>
          ))}
        </TextField>

        <Tooltip title={favorite ? 'Showing favorites only' : 'Show favorites only'}>
          <IconButton
            size="small"
            color={favorite ? 'error' : 'default'}
            aria-label="Show favorites only"
            aria-pressed={favorite}
            onClick={() => setFilter('favorite', favorite ? null : 'true')}
          >
            {favorite ? <FavoriteIcon /> : <FavoriteBorderIcon />}
          </IconButton>
        </Tooltip>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Skeleton grid — same geometry as the real one, so no layout jump. */}
      {showSkeletons && (
        <MemoryGrid>
          {Array.from({ length: 8 }, (_, i) => (
            <MemoryGridCell key={i} wide={i % 5 === 0}>
              <MemoryCardSkeleton size="large" wide={i % 5 === 0} />
            </MemoryGridCell>
          ))}
        </MemoryGrid>
      )}

      {/* Empty states */}
      {!showSkeletons && items.length === 0 && !error && (
        <EmptyState filtersActive={filtersActive} type={type} isAdmin={isAdmin} />
      )}

      {groups.map((group) => (
        <Box key={group.key} sx={{ mb: 4 }}>
          <Typography
            variant="overline"
            component="h2"
            sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: '0.08em' }}
          >
            {group.label}
          </Typography>
          <MemoryGrid>
            {group.items.map((memory) => (
              <MemoryGridItem
                key={memory.id}
                memory={memory}
                onOpen={openMemory}
                onSeen={actions.markSeen}
                onOpenMenu={(target) => setMenuTarget(target)}
              />
            ))}
          </MemoryGrid>
        </Box>
      ))}

      {/* Infinite-scroll sentinel */}
      <Box ref={sentinelRef} sx={{ height: 1 }} />
      {isLoading && !isInitialLoading && (
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 2 }}>
          Loading more memories…
        </Typography>
      )}

      {menuTarget && (
        <MemoryActionMenu
          open
          anchorEl={menuTarget.anchorEl}
          anchorPosition={menuTarget.anchorPosition}
          favorited={menuTarget.memory.myState.favorited}
          canDelete={isCollaborator}
          savingAlbum={savingAlbum}
          onClose={closeMenu}
          onPlay={() => {
            const target = menuTarget.memory;
            closeMenu();
            openMemory(target);
          }}
          onToggleFavorite={() => {
            const target = menuTarget.memory;
            closeMenu();
            void actions.setFavorite(target.id, !target.myState.favorited);
          }}
          onHide={() => {
            const target = menuTarget.memory;
            closeMenu();
            void actions.setHidden(target.id, true);
          }}
          onSaveAsAlbum={() => {
            const target = menuTarget.memory;
            closeMenu();
            void handleSaveAsAlbum(target);
          }}
          onDelete={() => {
            const target = menuTarget.memory;
            closeMenu();
            setDeleteTarget(target);
          }}
        />
      )}

      <DeleteMemoryDialog
        open={deleteTarget !== null}
        memoryTitle={deleteTarget?.title ?? ''}
        deleting={deleting}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        onHideInstead={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) void actions.setHidden(target.id, true);
        }}
      />

      <Snackbar
        open={toast !== null}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        message={toast?.message}
        action={
          toast?.albumId ? (
            <Button
              size="small"
              color="inherit"
              onClick={() => navigate(`/albums/${toast.albumId}`)}
            >
              View album
            </Button>
          ) : undefined
        }
      />

      <Snackbar
        open={actions.error !== null}
        autoHideDuration={6000}
        onClose={actions.clearError}
      >
        <Alert severity="error" onClose={actions.clearError} variant="filled">
          {actions.error}
        </Alert>
      </Snackbar>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Grid primitives
// ---------------------------------------------------------------------------

/**
 * Responsive masonry-feel grid. `auto-fill` + `minmax(240px, 1fr)` means the
 * column count is decided by the container, not by a breakpoint table, so this
 * works identically on a phone (one column) and an ultrawide.
 */
function MemoryGrid({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: 2,
        mt: 1,
      }}
    >
      {children}
    </Box>
  );
}

/**
 * A wide tile spans two columns from `md` up. It is NOT widened on a phone,
 * where the grid is a single column and a `span 2` would either overflow the
 * track or silently collapse.
 */
function MemoryGridCell({
  wide,
  children,
  ...rest
}: {
  wide: boolean;
  children: React.ReactNode;
} & React.ComponentProps<typeof Box>) {
  return (
    <Box sx={{ gridColumn: { xs: 'span 1', md: wide ? 'span 2' : 'span 1' } }} {...rest}>
      {children}
    </Box>
  );
}

function MemoryGridItem({
  memory,
  onOpen,
  onSeen,
  onOpenMenu,
}: {
  memory: MemoryCardDto;
  onOpen: (memory: MemoryCardDto) => void;
  onSeen: (id: string) => void;
  onOpenMenu: (target: MenuTarget) => void;
}) {
  const wide = isWideType(memory.type);
  const longPress = useLongPress((x, y) =>
    onOpenMenu({ memory, anchorEl: null, anchorPosition: { top: y, left: x } }),
  );

  return (
    <MemoryGridCell wide={wide} {...longPress}>
      <MemoryCard
        memory={memory}
        size="large"
        wide={wide}
        onOpen={onOpen}
        onSeen={onSeen}
        action={
          <IconButton
            size="small"
            aria-label={`Actions for ${memory.title}`}
            sx={{ color: '#fff' }}
            onClick={(e) =>
              onOpenMenu({ memory, anchorEl: e.currentTarget, anchorPosition: null })
            }
          >
            <MoreVertIcon fontSize="small" />
          </IconButton>
        }
      />
    </MemoryGridCell>
  );
}

// ---------------------------------------------------------------------------
// Empty states
//
// New-install correctness is an epic requirement: the flag can be on with zero
// memories generated yet, and that must read as "nothing here YET", never as a
// failure. The admin-only backfill hint is gated on the admin role because
// `/admin/settings/memories` is not reachable for anyone else.
// ---------------------------------------------------------------------------

function EmptyState({
  filtersActive,
  type,
  isAdmin,
}: {
  filtersActive: boolean;
  type: MemoryType | undefined;
  isAdmin: boolean;
}) {
  if (filtersActive) {
    return (
      <Box sx={{ textAlign: 'center', py: 8, px: 3 }}>
        <AutoAwesomeMotionIcon sx={{ fontSize: 56, color: 'text.disabled', mb: 2 }} />
        <Typography variant="h6" gutterBottom>
          {type
            ? `No ${memoryTypeMeta(type).emptyLabel} memories yet.`
            : 'No memories match these filters.'}
        </Typography>
        <Typography color="text.secondary">
          Try clearing a filter to see everything MemoriaHub has curated.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ textAlign: 'center', py: 10, px: 3 }}>
      <AutoAwesomeMotionIcon sx={{ fontSize: 72, color: 'text.disabled', mb: 2 }} />
      <Typography variant="h6" gutterBottom>
        Your memories will appear here
      </Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 460, mx: 'auto' }}>
        MemoriaHub curates them automatically as your library grows — trips,
        people, themes, and “on this day” moments from years past.
      </Typography>
      {isAdmin && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Admin:{' '}
          <Link component={RouterLink} to="/admin/settings/memories" underline="always">
            run a backfill
          </Link>{' '}
          to curate your existing library now.
        </Typography>
      )}
    </Box>
  );
}
