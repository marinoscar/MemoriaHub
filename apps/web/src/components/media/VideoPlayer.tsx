/**
 * VideoPlayer — Vidstack-powered video player with the default video layout.
 *
 * Features:
 * - Polished controls via DefaultVideoLayout (playback speed, scrubber, time, volume, fullscreen)
 * - Keyboard shortcuts handled by Vidstack out-of-the-box
 * - Large YouTube-style centered play/pause button (issue #236)
 * - Double-tap seek zones: left half = −10 s, right half = +10 s
 * - Responsive wrapper: 16:9 by default, or `fill` to use the whole container
 */

import '@vidstack/react/player/styles/default/theme.css';
import '@vidstack/react/player/styles/default/layouts/video.css';

import { MediaPlayer, MediaProvider, Gesture, PlayButton, useMediaState } from '@vidstack/react';
import type { MediaPlayerInstance } from '@vidstack/react';
import { defaultLayoutIcons, DefaultVideoLayout } from '@vidstack/react/player/layouts/default';
import { Box } from '@mui/material';
import {
  PlayArrowRounded as PlayArrowRoundedIcon,
  PauseRounded as PauseRoundedIcon,
} from '@mui/icons-material';
import type React from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VideoPlayerProps {
  src: string;
  poster?: string | null;
  title?: string;
  /**
   * Optional ref forwarded to the underlying MediaPlayer instance.
   * The parent can call `playerRef.current.currentTime = seconds` to seek.
   */
  playerRef?: React.Ref<MediaPlayerInstance>;
  /**
   * Fill the containing block instead of forcing a 16:9 box.
   *
   * Only safe where the parent has a definite height (the full-screen
   * lightbox). Everywhere else the default 16:9 wrapper is what gives the
   * player a height at all.
   */
  fill?: boolean;
}

// ---------------------------------------------------------------------------
// Centered play/pause overlay (issue #236)
// ---------------------------------------------------------------------------

/**
 * YouTube-style centered play affordance.
 *
 * Implemented with Vidstack's own `<PlayButton>` rather than a hand-rolled
 * overlay, so the toggle is wired by the player itself and the rendered
 * element is a real `<button>` — reachable with Tab, operable with
 * Enter/Space, and carrying an `aria-label` that tracks playback state.
 *
 * Interaction contract with the surrounding gesture layers:
 *
 * - Vidstack attaches its gesture listeners to the `[data-media-provider]`
 *   element (see `Gesture#attachListener`). This button is a *sibling* of
 *   `<MediaProvider>`, so a click here is never also seen by the gesture
 *   layer — no double toggle.
 * - `DefaultVideoLayout`'s ±10 s double-tap seek zones occupy only the outer
 *   20% of the left and right edges (`--video-gesture-seek-width`), so this
 *   centered target cannot swallow them.
 * - On touch devices Vidstack disables its own single-tap `toggle:paused`
 *   gesture entirely (`@media (pointer: coarse)` in its layout CSS), which is
 *   exactly why a phone had no reliable tap-to-play target before this.
 * - `MediaLightbox` already suppresses its own tap-to-toggle handler for
 *   video items (issue #235), so nothing at the lightbox level competes here.
 *
 * The overlay spans the whole player box, but only the button itself accepts
 * pointer events — the rest of the frame keeps its normal Vidstack behaviour.
 * Because the `<video>` is laid out with `object-fit: contain`, its centre
 * always coincides with the centre of the player box, so this button sits on
 * the middle of the *picture* even when the frame is letterboxed.
 */
function CenterPlayButton() {
  const paused = useMediaState('paused');

  return (
    <Box
      data-testid="center-play-overlay"
      data-paused={paused ? 'true' : 'false'}
      sx={(theme) => ({
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        // Above the poster (z-index 1) and the gesture layers (0–1), below
        // Vidstack's control bar (10) and its menus.
        zIndex: 2,
        '& .mh-center-play-button': {
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          border: 0,
          cursor: 'pointer',
          borderRadius: '50%',
          color: '#fff',
          backgroundColor: 'rgba(0, 0, 0, 0.55)',
          // Touch target: comfortably above the 56–64 px minimum on phones,
          // scaled up on tablet and desktop.
          width: 64,
          height: 64,
          [theme.breakpoints.up('sm')]: { width: 76, height: 76 },
          [theme.breakpoints.up('md')]: { width: 88, height: 88 },
          // Fade out on play, fade back in on pause.
          opacity: paused ? 1 : 0,
          transform: paused ? 'scale(1)' : 'scale(0.85)',
          transition: theme.transitions.create(['opacity', 'transform', 'background-color'], {
            duration: theme.transitions.duration.shorter,
          }),
          '&:hover': { backgroundColor: 'rgba(0, 0, 0, 0.75)' },
          // Keep the control discoverable for keyboard users while playing,
          // when it is otherwise faded out.
          '&:focus-visible': {
            opacity: 1,
            transform: 'scale(1)',
            outline: '2px solid #fff',
            outlineOffset: 2,
          },
        },
        '& .mh-center-play-button svg': {
          fontSize: 36,
          [theme.breakpoints.up('sm')]: { fontSize: 42 },
          [theme.breakpoints.up('md')]: { fontSize: 48 },
        },
      })}
    >
      <PlayButton
        className="mh-center-play-button"
        aria-label={paused ? 'Play video' : 'Pause video'}
      >
        {paused ? <PlayArrowRoundedIcon /> : <PauseRoundedIcon />}
      </PlayButton>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VideoPlayer({ src, poster, title, playerRef, fill = false }: VideoPlayerProps) {
  return (
    /*
     * Player wrapper.
     *
     * Default: a 16:9 aspect-ratio box at 100% of the containing block width —
     * the only thing giving the player a height in flow layouts such as the
     * detail drawer.
     *
     * `fill`: take the container's full width AND height and let the video's
     * own `object-fit: contain` size the picture. This is what stops a portrait
     * phone clip from being pillarboxed inside a short 16:9 letterbox in the
     * full-screen lightbox. Vidstack's defaults (`aspect-ratio: 16 / 9` on the
     * player, `height: auto` on the video) are declared with `:where(...)`, so
     * these overrides win on specificity without `!important`.
     */
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        ...(fill
          ? {
              height: '100%',
              '& [data-media-player]': { height: '100%', aspectRatio: 'auto' },
              '& video': { height: '100%' },
            }
          : { aspectRatio: '16 / 9' }),
        backgroundColor: 'black',
        borderRadius: 1,
        overflow: 'hidden',
      }}
    >
      <MediaPlayer
        ref={playerRef}
        src={src}
        poster={poster ?? undefined}
        title={title}
        crossOrigin
        playsInline
        aria-label={title ?? 'Video'}
        style={{ width: '100%', height: '100%' }}
      >
        <MediaProvider />

        {/*
         * Double-tap seek gestures (YouTube-mobile style).
         * GestureAction type: `seek:${number}` — negative seeks backward.
         *
         * These are declarative descriptors processed by the Vidstack player
         * internally; `.vds-gesture` has pointer-events:none in Vidstack CSS
         * and the player routes dblpointerup events to the matching zone.
         *
         * Left half — seek backward 10 s
         */}
        <Gesture
          className="vds-gesture"
          event="dblpointerup"
          action="seek:-10"
        />

        {/* Right half — seek forward 10 s */}
        <Gesture
          className="vds-gesture"
          event="dblpointerup"
          action="seek:10"
        />

        {/* Large centered play/pause target — see CenterPlayButton above. */}
        <CenterPlayButton />

        {/*
         * DefaultVideoLayout wires up:
         *   - Play/pause, mute, volume, fullscreen, PiP buttons
         *   - Time scrubber + elapsed / remaining time display
         *   - Playback-speed menu
         *   - Single-tap toggle-paused gesture (via its own DefaultVideoGestures)
         *   - Keyboard shortcuts (space, arrows, f, m, …)
         *
         * The small (phone) layout's own centre play button is suppressed: it
         * lives inside the auto-hiding control bar and would otherwise stack
         * on top of our persistent centered button.
         */}
        <DefaultVideoLayout
          icons={defaultLayoutIcons}
          slots={{ smallLayout: { playButton: null } }}
        />
      </MediaPlayer>
    </Box>
  );
}
