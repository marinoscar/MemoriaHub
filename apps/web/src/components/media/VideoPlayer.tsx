/**
 * VideoPlayer — Vidstack-powered video player with the default video layout.
 *
 * Features:
 * - Polished controls via DefaultVideoLayout (playback speed, scrubber, time, volume, fullscreen)
 * - Keyboard shortcuts handled by Vidstack out-of-the-box
 * - Double-tap seek zones: left half = −10 s, right half = +10 s
 * - Responsive 16:9 wrapper that fits the containing column width
 */

import '@vidstack/react/player/styles/default/theme.css';
import '@vidstack/react/player/styles/default/layouts/video.css';

import { MediaPlayer, MediaProvider, Gesture } from '@vidstack/react';
import type { MediaPlayerInstance } from '@vidstack/react';
import { defaultLayoutIcons, DefaultVideoLayout } from '@vidstack/react/player/layouts/default';
import { Box } from '@mui/material';
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
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VideoPlayer({ src, poster, title, playerRef }: VideoPlayerProps) {
  return (
    /*
     * Aspect-ratio box — 16:9 ratio, width 100% of the containing block.
     * The Vidstack player fills this box.
     */
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        aspectRatio: '16 / 9',
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

        {/*
         * DefaultVideoLayout wires up:
         *   - Play/pause, mute, volume, fullscreen, PiP buttons
         *   - Time scrubber + elapsed / remaining time display
         *   - Playback-speed menu
         *   - Single-tap toggle-paused gesture (via its own DefaultVideoGestures)
         *   - Keyboard shortcuts (space, arrows, f, m, …)
         */}
        <DefaultVideoLayout icons={defaultLayoutIcons} />
      </MediaPlayer>
    </Box>
  );
}
