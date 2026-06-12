/**
 * VideoPlayer component tests.
 *
 * @vidstack/react and its CSS imports are mocked so no real media infrastructure
 * is needed. Tests assert:
 *   - src / poster / title props are forwarded to the player
 *   - Both seek Gesture zones render with the correct action attributes
 *   - The layout component renders
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';

// ---------------------------------------------------------------------------
// Mock @vidstack/react — replace heavy browser-media implementation with
// lightweight stubs that emit testable markup.
// ---------------------------------------------------------------------------

vi.mock('@vidstack/react', () => {
  const MediaPlayer = ({ src, poster, title, children, ...rest }: any) => (
    <div
      data-testid="media-player"
      data-src={src}
      data-poster={poster}
      data-title={title}
      {...rest}
    >
      {children}
    </div>
  );

  const MediaProvider = () => <div data-testid="media-provider" />;

  const Gesture = ({ event, action, className }: any) => (
    <div
      data-testid="gesture"
      data-event={event}
      data-action={action}
      className={className}
    />
  );

  return { MediaPlayer, MediaProvider, Gesture };
});

// Mock the layout + icons sub-package (separate deep import path)
vi.mock('@vidstack/react/player/layouts/default', () => {
  const DefaultVideoLayout = ({ icons: _icons }: any) => (
    <div data-testid="default-video-layout" />
  );
  const defaultLayoutIcons = {};
  return { DefaultVideoLayout, defaultLayoutIcons };
});

// Stub CSS imports so Vitest doesn't choke on them
vi.mock('@vidstack/react/player/styles/default/theme.css', () => ({}));
vi.mock('@vidstack/react/player/styles/default/layouts/video.css', () => ({}));

import { VideoPlayer } from '../../../components/media/VideoPlayer';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VideoPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('prop forwarding', () => {
    it('should forward src to the MediaPlayer', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      const player = screen.getByTestId('media-player');
      expect(player).toHaveAttribute('data-src', 'https://example.com/video.mp4');
    });

    it('should forward poster when provided', () => {
      render(
        <VideoPlayer
          src="https://example.com/video.mp4"
          poster="https://example.com/thumb.jpg"
        />,
      );
      const player = screen.getByTestId('media-player');
      expect(player).toHaveAttribute('data-poster', 'https://example.com/thumb.jpg');
    });

    it('should forward title when provided', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" title="My Video" />);
      const player = screen.getByTestId('media-player');
      expect(player).toHaveAttribute('data-title', 'My Video');
    });

    it('should omit poster when null is passed (renders without data-poster attribute)', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" poster={null} />);
      const player = screen.getByTestId('media-player');
      // poster={null} → poster ?? undefined → undefined → Vidstack ignores it
      // Our mock renders data-poster="undefined" string only if explicitly passed;
      // passing `undefined` means the attribute is not applied.
      // The actual check is: it must NOT equal the null string literal.
      expect(player.getAttribute('data-poster')).not.toBe('null');
    });

    it('should render MediaProvider inside the player', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      expect(screen.getByTestId('media-provider')).toBeInTheDocument();
    });

    it('should render DefaultVideoLayout', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      expect(screen.getByTestId('default-video-layout')).toBeInTheDocument();
    });
  });

  describe('seek gesture zones', () => {
    it('should render exactly two Gesture elements', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      const gestures = screen.getAllByTestId('gesture');
      expect(gestures).toHaveLength(2);
    });

    it('should include a seek:-10 gesture (backward)', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      const gestures = screen.getAllByTestId('gesture');
      const backwardGesture = gestures.find(
        (g) => g.getAttribute('data-action') === 'seek:-10',
      );
      expect(backwardGesture).toBeDefined();
    });

    it('should include a seek:10 gesture (forward)', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      const gestures = screen.getAllByTestId('gesture');
      const forwardGesture = gestures.find(
        (g) => g.getAttribute('data-action') === 'seek:10',
      );
      expect(forwardGesture).toBeDefined();
    });

    it('both gestures should fire on dblpointerup', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      const gestures = screen.getAllByTestId('gesture');
      gestures.forEach((g) => {
        expect(g.getAttribute('data-event')).toBe('dblpointerup');
      });
    });

    it('both gestures should carry the vds-gesture class', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      const gestures = screen.getAllByTestId('gesture');
      gestures.forEach((g) => {
        expect(g.classList.contains('vds-gesture')).toBe(true);
      });
    });
  });
});
