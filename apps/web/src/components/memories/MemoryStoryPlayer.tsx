// ---------------------------------------------------------------------------
// MemoryStoryPlayer — the full-screen, auto-advancing story (epic #300, #313)
//
// WHY THIS IS NOT `MediaLightbox` WITH A FLAG
// -------------------------------------------
// `MediaLightbox` is ~1000 lines of viewer: zoom, properties pane, orientation
// editing, enhance, archive, trash, tag/metadata reruns, an overflow menu, and
// a 4-second fixed-interval slideshow bolted on top. A story is a different
// interaction model end to end — per-item timing, segmented progress, hold to
// pause, Ken Burns, a title card and an end card — and every one of those would
// have had to be threaded through code paths that exist for a completely
// different surface. What IS reused is the low-level machinery, not the shell:
// `getMedia()` for the signed full-resolution URL, the module-scope item cache
// pattern, the neighbour prefetch, the pointer-swipe arithmetic, and `Dialog
// fullScreen` (whose Modal gives the focus trap for free, so the accessibility
// requirement is met by the framework rather than by a hand-rolled trap).
//
// THE TIMING MODEL (all constants in `storyTiming.ts`)
// ----------------------------------------------------
// A story is a walk over `[-1, 0 … n-1, n]`: -1 is the title card, 0…n-1 the
// items, n the end card. Each step has a duration (`null` on the end card,
// which never auto-advances) and TWO synchronized clocks:
//
//   * a `setTimeout` that performs the advance, and
//   * a CSS animation that fills the active progress segment.
//
// They are separate on purpose. Driving the bar from JS would mean a rAF loop
// re-rendering the tree 60 times a second for a decoration; driving the advance
// from `animationend` would tie correctness to an animation that
// `prefers-reduced-motion`, a background tab, or a `display:none` ancestor can
// legally not run. So: JS owns correctness, CSS owns smoothness, and both are
// paused by the same boolean — `animation-play-state: paused` freezes the fill
// exactly where the timer's remaining-time arithmetic freezes the clock.
//
// PAUSE IS A DERIVED VALUE, not a state. `paused = userPaused || holding ||
// dialogOpen`, so a press-and-hold, an open save-as-album dialog and the pause
// button all take the same code path and cannot disagree about who resumed.
//
// REDUCED MOTION suppresses Ken Burns, the crossfade and the title card's
// staggered fade-ups — the player keeps working, it just cuts instead of
// gliding. The progress fill is deliberately NOT suppressed: it is the only
// indication of how long the current slide will hold, which makes it feedback
// rather than decoration.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  Close as CloseIcon,
  Favorite as FavoriteIcon,
  FavoriteBorder as FavoriteBorderIcon,
  IosShare as IosShareIcon,
  Pause as PauseIcon,
  PhotoAlbum as PhotoAlbumIcon,
  PhotoLibrary as PhotoLibraryIcon,
  PlayArrow as PlayArrowIcon,
  Replay as ReplayIcon,
  VolumeOff as VolumeOffIcon,
  VolumeUp as VolumeUpIcon,
} from '@mui/icons-material';

import { getMedia } from '../../services/media';
import type { MediaItem } from '../../types/media';
import type { MemoryDetail, MemoryDetailItem } from '../../types/memories';
import { memoryTypeMeta } from './memoryTypeMeta';
import {
  CROSSFADE_MS,
  HOLD_CANCEL_SLOP_PX,
  HOLD_TO_PAUSE_MS,
  PRELOAD_AHEAD,
  SWIPE_THRESHOLD_PX,
  TAP_BACK_ZONE_FRACTION,
  TITLE_CARD_DURATION_MS,
  TITLE_INDEX,
  describeStep,
  formatItemCaption,
  isVideoItem,
  resolveItemDurationMs,
} from './storyTiming';

// ---------------------------------------------------------------------------
// Full-media cache
//
// Module scope so reopening a memory — or replaying it — is instant, exactly
// like `MediaLightbox`'s `fullItemCache`. Signed URLs carry a 24h TTL and the
// player is a seconds-long surface, so nothing here can go stale within a
// session in a way the user would see.
// ---------------------------------------------------------------------------

const fullMediaCache = new Map<string, MediaItem>();

/** Test hook: drop everything the player has resolved so far. */
export function resetStoryMediaCache(): void {
  fullMediaCache.clear();
}

const visuallyHidden = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute' as const,
  whiteSpace: 'nowrap' as const,
  width: '1px',
};

// ---------------------------------------------------------------------------
// Auto-advance clock
// ---------------------------------------------------------------------------

/**
 * Hold for `durationMs`, then call `onDone` — pausable, with the unspent
 * remainder carried across the pause.
 *
 * `stepKey` (not `durationMs`) is the reset signal: two consecutive photos both
 * last 5000ms, so keying the restart on the duration would leave the second one
 * running out the first one's timer and advancing early.
 *
 * `durationMs === null` means "never advance" — the end card.
 */
function useAutoAdvance(
  stepKey: number,
  durationMs: number | null,
  paused: boolean,
  onDone: () => void,
): void {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const remainingRef = useRef<number | null>(durationMs);
  const startedAtRef = useRef<number | null>(null);

  // Declared BEFORE the timer effect so that on a step change React runs the
  // previous timer's cleanup (which banks the elapsed time), then this reset,
  // then the new timer — in that order. Reversing the two would have the reset
  // immediately overwritten by the banked remainder of the previous slide.
  useEffect(() => {
    remainingRef.current = durationMs;
    startedAtRef.current = null;
  }, [stepKey, durationMs]);

  useEffect(() => {
    if (paused || durationMs === null) return undefined;

    const remaining = remainingRef.current ?? durationMs;
    startedAtRef.current = Date.now();
    const timer = setTimeout(() => {
      startedAtRef.current = null;
      remainingRef.current = null;
      onDoneRef.current();
    }, Math.max(0, remaining));

    return () => {
      clearTimeout(timer);
      // Bank whatever is left so a resume continues rather than restarting.
      if (startedAtRef.current !== null) {
        const elapsed = Date.now() - startedAtRef.current;
        const left = (remainingRef.current ?? durationMs) - elapsed;
        remainingRef.current = Math.max(0, left);
        startedAtRef.current = null;
      }
    };
  }, [stepKey, durationMs, paused]);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MemoryStoryPlayerProps {
  memory: MemoryDetail;
  open: boolean;
  onClose: () => void;
  /**
   * Fired once per open. The owner decides what "seen" means and owns the
   * per-session dedup (`useMemoryActions.markSeen`); the player never calls the
   * API itself, so it stays testable without a network layer.
   */
  onSeen?: (id: string) => void;
  /** End-card heart. Returns once the optimistic flip has been attempted. */
  onToggleFavorite?: (next: boolean) => void;
  /** End-card "Save as album" — the owner opens the naming dialog. */
  onSaveAsAlbum?: () => void;
  /** End-card "Share" — the owner runs the save-then-share hand-off. */
  onShare?: () => void;
  /** End-card "View all photos" — the owner navigates to the detail grid. */
  onViewAllPhotos?: () => void;
  /**
   * True while the owner has a dialog of its own open over the player (save as
   * album, share). Playback pauses so the story is not running unwatched
   * behind a modal.
   */
  suspended?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MemoryStoryPlayer({
  memory,
  open,
  onClose,
  onSeen,
  onToggleFavorite,
  onSaveAsAlbum,
  onShare,
  onViewAllPhotos,
  suspended = false,
}: MemoryStoryPlayerProps) {
  const theme = useTheme();
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));

  const items = memory.items;
  const lastIndex = items.length - 1;
  const endIndex = items.length;

  const [index, setIndex] = useState(TITLE_INDEX);
  const [userPaused, setUserPaused] = useState(false);
  const [holding, setHolding] = useState(false);
  const [muted, setMuted] = useState(true);
  /**
   * What the `<video>` element reported for ONE item, tagged with that item's
   * id. Tagging it is what removes the need to reset it on every navigation:
   * a measurement can never be read against the wrong slide, so there is no
   * window in which the previous clip's length paces the next one.
   */
  const [videoDuration, setVideoDuration] = useState<{ id: string; ms: number } | null>(
    null,
  );
  const [resolved, setResolved] = useState<Record<string, MediaItem>>({});

  const paused = userPaused || holding || suspended;
  const current = index >= 0 && index <= lastIndex ? items[index] : null;
  const meta = memoryTypeMeta(memory.type);

  // --- reset on every open ------------------------------------------------
  //
  // Seeded here rather than on mount because the owner keeps the player mounted
  // across opens (the `MediaLightbox` consumer pattern); without this, reopening
  // would resume on the end card of the previous viewing.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setIndex(TITLE_INDEX);
      setUserPaused(false);
      setHolding(false);
      setMuted(true);
      setVideoDuration(null);
      onSeen?.(memory.id);
    }
    wasOpenRef.current = open;
    // `onSeen` identity must not re-fire the seen write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, memory.id]);

  // --- media resolution ---------------------------------------------------
  //
  // The memory DTO ships a signed THUMBNAIL per item (800px) and no place name.
  // A full-screen story needs the original bytes — mandatory for a video, and
  // visibly better for a photo on a desktop display — plus `geoLocality` for
  // the caption. Both come from `GET /api/media/:id`, so the current slide and
  // the next `PRELOAD_AHEAD` are resolved and cached. The thumbnail is shown
  // underneath meanwhile, which is why a slow fetch degrades to "slightly soft"
  // rather than to a black frame.
  useEffect(() => {
    if (!open) return;
    const wanted = new Set<string>();
    for (let i = Math.max(0, index); i <= Math.min(lastIndex, index + PRELOAD_AHEAD); i += 1) {
      if (i >= 0 && items[i]) wanted.add(items[i].mediaItemId);
    }

    let cancelled = false;
    for (const mediaItemId of wanted) {
      const cached = fullMediaCache.get(mediaItemId);
      if (cached) {
        setResolved((prev) => (prev[mediaItemId] ? prev : { ...prev, [mediaItemId]: cached }));
        continue;
      }
      void getMedia(mediaItemId)
        .then((media) => {
          fullMediaCache.set(mediaItemId, media);
          if (cancelled) return;
          setResolved((prev) => ({ ...prev, [mediaItemId]: media }));
          // Warm the browser cache for the ORIGINAL bytes too, so the swap from
          // thumbnail to full-res has already happened by the time the slide
          // becomes current — this is what removes the flash on advance.
          if (media.type === 'photo' && media.downloadUrl) {
            const img = new Image();
            img.src = media.downloadUrl;
          }
        })
        .catch(() => {
          // Non-fatal: the slide keeps its thumbnail, and a video slide shows
          // its poster and simply advances on the timer.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, index, items, lastIndex]);

  // --- navigation ---------------------------------------------------------

  const goTo = useCallback(
    (next: number) => setIndex(Math.max(TITLE_INDEX, Math.min(endIndex, next))),
    [endIndex],
  );

  const goNext = useCallback(
    () => setIndex((prev) => (prev >= endIndex ? prev : prev + 1)),
    [endIndex],
  );

  const goPrev = useCallback(
    () => setIndex((prev) => (prev <= TITLE_INDEX ? prev : prev - 1)),
    [],
  );

  const replay = useCallback(() => {
    setUserPaused(false);
    setIndex(TITLE_INDEX);
  }, []);

  // --- the clock ----------------------------------------------------------

  const stepDurationMs = useMemo(() => {
    if (index === TITLE_INDEX) return TITLE_CARD_DURATION_MS;
    if (index >= endIndex) return null; // end card: the story waits for the user
    const item = items[index];
    if (!item) return null;
    const measured = videoDuration?.id === item.id ? videoDuration.ms : null;
    return resolveItemDurationMs(item, measured);
  }, [index, endIndex, items, videoDuration]);

  useAutoAdvance(index, open ? stepDurationMs : null, paused, goNext);

  // --- keyboard -----------------------------------------------------------
  //
  // Bound to the window rather than to the dialog node so the shortcuts work
  // wherever focus happens to sit inside the trap — including on the backdrop,
  // which is what has focus immediately after the dialog opens.
  useEffect(() => {
    if (!open) return undefined;

    const handleKey = (event: KeyboardEvent) => {
      // Never steal a key from a control that has its own meaning for it: Space
      // must still activate the focused button, and typing must still type.
      const target = event.target as HTMLElement | null;
      const interactive = target?.closest?.(
        'button, a, input, textarea, select, [role="button"], [contenteditable="true"]',
      );

      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          goNext();
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          goPrev();
          break;
        case ' ':
        case 'Spacebar':
          if (interactive) return;
          event.preventDefault();
          setUserPaused((p) => !p);
          break;
        case 'Home':
          event.preventDefault();
          goTo(TITLE_INDEX);
          break;
        case 'End':
          event.preventDefault();
          goTo(endIndex);
          break;
        case 'm':
        case 'M':
          if (interactive) return;
          setMuted((m) => !m);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, goNext, goPrev, goTo, endIndex]);

  // --- pointer: tap zones, hold-to-pause, swipe ---------------------------

  const pointerRef = useRef({ x: 0, y: 0, moved: false, held: false });
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoldTimer = () => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  useEffect(() => clearHoldTimer, []);

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    pointerRef.current = { x: event.clientX, y: event.clientY, moved: false, held: false };
    clearHoldTimer();
    holdTimerRef.current = setTimeout(() => {
      pointerRef.current.held = true;
      setHolding(true);
    }, HOLD_TO_PAUSE_MS);
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const start = pointerRef.current;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > HOLD_CANCEL_SLOP_PX || Math.abs(dy) > HOLD_CANCEL_SLOP_PX) {
      start.moved = true;
      // A drag is a swipe attempt, not a hold — but a hold that has ALREADY
      // engaged stays engaged, so a finger that shifts slightly while resting
      // on the screen does not silently resume playback.
      if (!start.held) clearHoldTimer();
    }
  }, []);

  const handlePointerUp = useCallback(
    (event: React.PointerEvent) => {
      clearHoldTimer();
      const start = pointerRef.current;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;

      if (start.held) {
        setHolding(false);
        return;
      }

      if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) goNext();
        else goPrev();
        return;
      }

      if (start.moved) return;

      const rect = event.currentTarget.getBoundingClientRect();
      const relative = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 1;
      if (relative < TAP_BACK_ZONE_FRACTION) goPrev();
      else goNext();
    },
    [goNext, goPrev],
  );

  const handlePointerCancel = useCallback(() => {
    clearHoldTimer();
    if (pointerRef.current.held) {
      pointerRef.current.held = false;
      setHolding(false);
    }
  }, []);

  // --- video element ------------------------------------------------------

  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (paused) {
      video.pause();
    } else {
      // Autoplay can be refused (a hostile policy, a decode failure). The story
      // keeps its own clock, so a refused play degrades to a still poster that
      // still advances on time rather than to a frozen story.
      void video.play().catch(() => undefined);
    }
  }, [paused, index]);

  const announcement = useMemo(
    () => describeStep(index, items, memory.title),
    [index, items, memory.title],
  );

  if (!open) return null;

  const currentMedia = current ? resolved[current.mediaItemId] : undefined;
  const currentIsVideo = current ? isVideoItem(current) : false;
  const caption = current
    ? formatItemCaption(current.capturedAt, currentMedia?.geoLocality)
    : null;

  const showChevrons = isDesktop && index > TITLE_INDEX && index < endIndex;

  return (
    <Dialog
      fullScreen
      open={open}
      onClose={onClose}
      aria-label={`${memory.title} — memory story`}
      transitionDuration={reduceMotion ? 0 : 220}
      slotProps={{
        paper: {
          sx: {
            backgroundColor: '#000',
            overflow: 'hidden',
            // Notch / home-indicator safety on a phone. The media itself fills
            // edge to edge; only the chrome is inset.
            '--story-inset-top': 'env(safe-area-inset-top, 0px)',
            '--story-inset-bottom': 'env(safe-area-inset-bottom, 0px)',
          },
        },
      }}
      // The player owns its own zIndex above the app bars.
      sx={{ zIndex: (t) => t.zIndex.modal }}
    >
      <Box
        data-testid="memory-story-player"
        sx={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
      >
        {/* ---------------------------------------------------------------
            Slides. Only the window around the current index is mounted; the
            neighbours are mounted at opacity 0 SPECIFICALLY so the browser has
            already decoded them by the time they become current. */}
        {items.map((item, i) => {
          if (i < index - 1 || i > index + PRELOAD_AHEAD) return null;
          const isCurrent = i === index;
          return (
            <SlideLayer
              key={item.id}
              item={item}
              media={resolved[item.mediaItemId]}
              current={isCurrent}
              reduceMotion={reduceMotion}
              paused={paused}
              durationMs={isCurrent ? (stepDurationMs ?? 0) : 0}
              kenBurnsVariant={i % 2 === 0 ? 'a' : 'b'}
              muted={muted}
              videoRef={isCurrent && isVideoItem(item) ? videoRef : undefined}
              onVideoDuration={
                isCurrent ? (ms) => setVideoDuration({ id: item.id, ms }) : undefined
              }
            />
          );
        })}

        {index === TITLE_INDEX && (
          <TitleCard memory={memory} reduceMotion={reduceMotion} typeLabel={meta.label} />
        )}

        {index >= endIndex && (
          <EndCard
            memory={memory}
            onReplay={replay}
            onToggleFavorite={onToggleFavorite}
            onSaveAsAlbum={onSaveAsAlbum}
            onShare={onShare}
            onViewAllPhotos={onViewAllPhotos}
          />
        )}

        {/* ---------------------------------------------------------------
            Gesture surface. Sits ABOVE the slides and BELOW the chrome, so a
            tap anywhere on the photo navigates while every button keeps
            working. It is `aria-hidden` and not focusable: keyboard users get
            the arrow keys and the explicit chevrons, so exposing an unlabelled
            full-screen hit target would only add noise to the tab order. */}
        {index < endIndex && (
          <Box
            aria-hidden
            data-testid="story-gesture-surface"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onContextMenu={(e) => e.preventDefault()}
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 5,
              touchAction: 'pan-y',
              cursor: 'pointer',
            }}
          />
        )}

        {/* --------------------------------------------------------------- */}
        <ProgressSegments
          items={items}
          index={index}
          durationMs={stepDurationMs}
          paused={paused}
          endIndex={endIndex}
          title={memory.title}
        />

        {/* Top chrome */}
        <Stack
          direction="row"
          spacing={0.5}
          sx={{
            position: 'absolute',
            top: 'calc(var(--story-inset-top) + 18px)',
            right: 8,
            zIndex: 20,
            alignItems: 'center',
          }}
        >
          {currentIsVideo && (
            <Tooltip title={muted ? 'Unmute (M)' : 'Mute (M)'}>
              <IconButton
                aria-label={muted ? 'Unmute video' : 'Mute video'}
                aria-pressed={!muted}
                onClick={() => setMuted((m) => !m)}
                sx={storyIconButtonSx}
              >
                {muted ? <VolumeOffIcon /> : <VolumeUpIcon />}
              </IconButton>
            </Tooltip>
          )}
          {index < endIndex && (
            <Tooltip title={paused ? 'Play (Space)' : 'Pause (Space)'}>
              <IconButton
                aria-label={paused ? 'Play story' : 'Pause story'}
                aria-pressed={paused}
                onClick={() => setUserPaused((p) => !p)}
                sx={storyIconButtonSx}
              >
                {paused ? <PlayArrowIcon /> : <PauseIcon />}
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Close (Esc)">
            <IconButton aria-label="Close story" onClick={onClose} sx={storyIconButtonSx}>
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </Stack>

        {/* Desktop-only explicit navigation. Hidden until hover/focus so the
            immersive frame stays clean, but ALWAYS reachable by keyboard —
            `:focus-within` brings them back for a tab user. */}
        {showChevrons && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 15,
              pointerEvents: 'none',
              opacity: 0,
              transition: reduceMotion ? 'none' : 'opacity 180ms ease',
              '&:hover, &:focus-within': { opacity: 1 },
            }}
          >
            <IconButton
              aria-label="Previous slide"
              onClick={goPrev}
              sx={{ ...storyIconButtonSx, ...storyChevronSx, left: 12, pointerEvents: 'auto' }}
            >
              <ChevronLeftIcon />
            </IconButton>
            <IconButton
              aria-label="Next slide"
              onClick={goNext}
              sx={{ ...storyIconButtonSx, ...storyChevronSx, right: 12, pointerEvents: 'auto' }}
            >
              <ChevronRightIcon />
            </IconButton>
          </Box>
        )}

        {/* Caption */}
        {caption && index < endIndex && (
          <Box
            sx={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 12,
              px: 2,
              pt: 6,
              pb: 'calc(var(--story-inset-bottom) + 16px)',
              pointerEvents: 'none',
              background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent)',
            }}
          >
            <Typography sx={{ color: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: 500 }}>
              {caption}
            </Typography>
          </Box>
        )}

        {/* The one channel a screen-reader user has for position in the story. */}
        <Box role="status" aria-live="polite" sx={visuallyHidden}>
          {announcement}
        </Box>
      </Box>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shared chrome styles
// ---------------------------------------------------------------------------

const storyIconButtonSx = {
  color: '#fff',
  backgroundColor: 'rgba(0,0,0,0.35)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  minWidth: 44,
  minHeight: 44,
  '&:hover': { backgroundColor: 'rgba(0,0,0,0.6)' },
} as const;

const storyChevronSx = {
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
} as const;

// ---------------------------------------------------------------------------
// Progress segments
// ---------------------------------------------------------------------------

/**
 * Instagram-style segmented bar.
 *
 * ARIA: the bar as a whole is ONE `progressbar` whose value is the slide
 * number; the individual segments are decorative and hidden. Marking each
 * segment up as its own progressbar would announce a dozen unlabelled meters
 * and tell the user nothing about where they are, which is what the polite live
 * region in the player is for.
 */
function ProgressSegments({
  items,
  index,
  durationMs,
  paused,
  endIndex,
  title,
}: {
  items: MemoryDetailItem[];
  index: number;
  durationMs: number | null;
  paused: boolean;
  endIndex: number;
  title: string;
}) {
  if (items.length === 0) return null;

  const position = Math.min(Math.max(index + 1, 0), items.length);

  return (
    <Box
      role="progressbar"
      aria-label={`${title} story progress`}
      aria-valuemin={0}
      aria-valuemax={items.length}
      aria-valuenow={position}
      aria-valuetext={
        index >= endIndex
          ? 'End of story'
          : index < 0
            ? 'Title card'
            : `Slide ${index + 1} of ${items.length}`
      }
      sx={{
        position: 'absolute',
        top: 'calc(var(--story-inset-top) + 8px)',
        left: 8,
        right: 8,
        zIndex: 20,
        display: 'flex',
        gap: '3px',
        pointerEvents: 'none',
      }}
    >
      {items.map((item, i) => {
        const done = i < index || index >= endIndex;
        const active = i === index;
        return (
          <Box
            key={item.id}
            aria-hidden
            sx={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              overflow: 'hidden',
              backgroundColor: 'rgba(255,255,255,0.3)',
            }}
          >
            <Box
              // Re-keyed per step so the fill animation restarts from 0 rather
              // than continuing the previous segment's timeline.
              key={`${i}-${index}`}
              data-testid={active ? 'story-progress-active' : undefined}
              sx={{
                height: '100%',
                backgroundColor: '#fff',
                transformOrigin: 'left center',
                transform: done ? 'scaleX(1)' : 'scaleX(0)',
                ...(active && durationMs
                  ? {
                      animation: `story-progress-fill ${durationMs}ms linear forwards`,
                      animationPlayState: paused ? 'paused' : 'running',
                      '@keyframes story-progress-fill': {
                        from: { transform: 'scaleX(0)' },
                        to: { transform: 'scaleX(1)' },
                      },
                    }
                  : null),
              }}
            />
          </Box>
        );
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// One slide
// ---------------------------------------------------------------------------

function SlideLayer({
  item,
  media,
  current,
  reduceMotion,
  paused,
  durationMs,
  kenBurnsVariant,
  muted,
  videoRef,
  onVideoDuration,
}: {
  item: MemoryDetailItem;
  media: MediaItem | undefined;
  current: boolean;
  reduceMotion: boolean;
  paused: boolean;
  durationMs: number;
  kenBurnsVariant: 'a' | 'b';
  muted: boolean;
  videoRef?: React.MutableRefObject<HTMLVideoElement | null>;
  onVideoDuration?: (ms: number) => void;
}) {
  const video = isVideoItem(item);
  const poster = item.thumbnailUrl ?? undefined;
  const source = media?.downloadUrl ?? null;

  return (
    <Box
      data-testid="story-slide"
      data-current={current ? 'true' : 'false'}
      sx={{
        position: 'absolute',
        inset: 0,
        opacity: current ? 1 : 0,
        transition: reduceMotion ? 'none' : `opacity ${CROSSFADE_MS}ms ease`,
        // A hidden neighbour must not eat a pointer event meant for the surface.
        pointerEvents: 'none',
      }}
    >
      {/* Blurred backdrop so a portrait photo on a wide screen sits in its own
          colour rather than in two black bars. Cheap: it is the thumbnail, not
          a second copy of the original. */}
      {poster && (
        <Box
          aria-hidden
          component="img"
          src={poster}
          alt=""
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: 'blur(28px) brightness(0.45)',
            transform: 'scale(1.15)',
          }}
        />
      )}

      {video ? (
        current && source ? (
          <Box
            component="video"
            ref={videoRef}
            src={source}
            poster={poster}
            muted={muted}
            autoPlay
            loop
            playsInline
            preload="auto"
            onLoadedMetadata={(e: React.SyntheticEvent<HTMLVideoElement>) => {
              const seconds = e.currentTarget.duration;
              if (Number.isFinite(seconds) && seconds > 0) {
                onVideoDuration?.(Math.round(seconds * 1000));
              }
            }}
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
            }}
          />
        ) : (
          poster && (
            <Box
              component="img"
              src={poster}
              alt=""
              sx={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'contain',
              }}
            />
          )
        )
      ) : (
        <Box
          component="img"
          // The full-resolution original replaces the thumbnail in place once
          // it has resolved. Same element, so there is no second fade and no
          // reflow — only the `src` changes.
          src={media?.downloadUrl ?? poster}
          alt=""
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            ...(current && !reduceMotion && durationMs > 0
              ? {
                  animation: `story-ken-burns-${kenBurnsVariant} ${durationMs}ms ease-out forwards`,
                  animationPlayState: paused ? 'paused' : 'running',
                  // Transform-only, so this stays on the compositor: no layout,
                  // no paint, no jank on a phone.
                  '@keyframes story-ken-burns-a': {
                    from: { transform: 'scale(1) translate3d(0, 0, 0)' },
                    to: { transform: 'scale(1.08) translate3d(-1.5%, -1%, 0)' },
                  },
                  '@keyframes story-ken-burns-b': {
                    from: { transform: 'scale(1.08) translate3d(1.5%, 1%, 0)' },
                    to: { transform: 'scale(1) translate3d(0, 0, 0)' },
                  },
                }
              : null),
          }}
        />
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Title card
// ---------------------------------------------------------------------------

function TitleCard({
  memory,
  reduceMotion,
  typeLabel,
}: {
  memory: MemoryDetail;
  reduceMotion: boolean;
  typeLabel: string;
}) {
  // Staggered fade-ups: the type chip, then the title, then the subtitle, then
  // the narrative. Under reduced motion everything is simply present.
  const rise = (delayMs: number) =>
    reduceMotion
      ? {}
      : {
          opacity: 0,
          animation: `story-rise 380ms ease-out ${delayMs}ms forwards`,
          '@keyframes story-rise': {
            from: { opacity: 0, transform: 'translate3d(0, 14px, 0)' },
            to: { opacity: 1, transform: 'translate3d(0, 0, 0)' },
          },
        };

  return (
    <Box
      data-testid="story-title-card"
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: 8,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        px: { xs: 3, md: 8 },
        py: 8,
      }}
    >
      {memory.coverThumbnailUrl && (
        <Box
          aria-hidden
          component="img"
          src={memory.coverThumbnailUrl}
          alt=""
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: 'blur(24px) brightness(0.4)',
            transform: 'scale(1.1)',
          }}
        />
      )}

      <Box sx={{ position: 'relative', maxWidth: 720 }}>
        <Typography
          sx={{
            display: 'inline-block',
            px: 1,
            py: 0.25,
            mb: 2,
            borderRadius: 10,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: '#fff',
            backgroundColor: 'rgba(255,255,255,0.2)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            ...rise(0),
          }}
        >
          {typeLabel}
        </Typography>

        <Typography
          component="h2"
          sx={{
            color: '#fff',
            fontWeight: 700,
            lineHeight: 1.1,
            fontSize: { xs: 34, sm: 44, md: 56 },
            textShadow: '0 2px 24px rgba(0,0,0,0.5)',
            ...rise(120),
          }}
        >
          {memory.title}
        </Typography>

        {memory.subtitle && (
          <Typography
            sx={{
              mt: 1.5,
              color: 'rgba(255,255,255,0.85)',
              fontSize: { xs: 16, md: 20 },
              ...rise(240),
            }}
          >
            {memory.subtitle}
          </Typography>
        )}

        {memory.narrative && (
          <Typography
            sx={{
              mt: 3,
              color: 'rgba(255,255,255,0.75)',
              fontSize: { xs: 14, md: 16 },
              fontStyle: 'italic',
              maxWidth: 560,
              ...rise(360),
            }}
          >
            {memory.narrative}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// End card
// ---------------------------------------------------------------------------

function EndCard({
  memory,
  onReplay,
  onToggleFavorite,
  onSaveAsAlbum,
  onShare,
  onViewAllPhotos,
}: {
  memory: MemoryDetail;
  onReplay: () => void;
  onToggleFavorite?: (next: boolean) => void;
  onSaveAsAlbum?: () => void;
  onShare?: () => void;
  onViewAllPhotos?: () => void;
}) {
  const favorited = memory.myState.favorited;
  const collage = memory.items
    .map((item) => item.thumbnailUrl)
    .filter((url): url is string => Boolean(url))
    .slice(0, 4);

  return (
    <Box
      data-testid="story-end-card"
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        px: 3,
        pt: 'calc(var(--story-inset-top) + 48px)',
        pb: 'calc(var(--story-inset-bottom) + 24px)',
        backgroundColor: 'rgba(0,0,0,0.86)',
        overflowY: 'auto',
      }}
    >
      {collage.length > 0 && (
        <Box
          aria-hidden
          sx={{
            display: 'grid',
            gridTemplateColumns: collage.length > 1 ? '1fr 1fr' : '1fr',
            gap: 1,
            width: { xs: 220, sm: 280 },
          }}
        >
          {collage.map((url) => (
            <Box
              key={url}
              component="img"
              src={url}
              alt=""
              sx={{
                width: '100%',
                aspectRatio: '1 / 1',
                objectFit: 'cover',
                borderRadius: 2,
                boxShadow: 6,
              }}
            />
          ))}
        </Box>
      )}

      <Box sx={{ textAlign: 'center' }}>
        <Typography
          component="h2"
          sx={{ color: '#fff', fontWeight: 700, fontSize: { xs: 22, md: 28 } }}
        >
          {memory.title}
        </Typography>
        <Typography sx={{ color: 'rgba(255,255,255,0.7)', mt: 0.5, fontSize: 14 }}>
          {memory.itemCount} {memory.itemCount === 1 ? 'item' : 'items'}
        </Typography>
      </Box>

      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ flexWrap: 'wrap', justifyContent: 'center' }}
      >
        <Button
          variant="contained"
          startIcon={<ReplayIcon />}
          onClick={onReplay}
          sx={{ backgroundColor: '#fff', color: '#000', '&:hover': { backgroundColor: '#e0e0e0' } }}
        >
          Replay
        </Button>
        {onToggleFavorite && (
          <Button
            variant="outlined"
            aria-pressed={favorited}
            startIcon={favorited ? <FavoriteIcon color="error" /> : <FavoriteBorderIcon />}
            onClick={() => onToggleFavorite(!favorited)}
            sx={storyOutlinedButtonSx}
          >
            {favorited ? 'Favorited' : 'Favorite'}
          </Button>
        )}
        {onSaveAsAlbum && (
          <Button
            variant="outlined"
            startIcon={<PhotoAlbumIcon />}
            onClick={onSaveAsAlbum}
            sx={storyOutlinedButtonSx}
          >
            Save as album
          </Button>
        )}
        {onShare && (
          <Tooltip title="Creates a shareable album from this memory, then gives you a public link">
            <Button
              variant="outlined"
              startIcon={<IosShareIcon />}
              onClick={onShare}
              sx={storyOutlinedButtonSx}
            >
              Share
            </Button>
          </Tooltip>
        )}
        {onViewAllPhotos && (
          <Button
            variant="outlined"
            startIcon={<PhotoLibraryIcon />}
            onClick={onViewAllPhotos}
            sx={storyOutlinedButtonSx}
          >
            View all photos
          </Button>
        )}
      </Stack>
    </Box>
  );
}

const storyOutlinedButtonSx = {
  color: '#fff',
  borderColor: 'rgba(255,255,255,0.4)',
  '&:hover': { borderColor: '#fff', backgroundColor: 'rgba(255,255,255,0.08)' },
} as const;
