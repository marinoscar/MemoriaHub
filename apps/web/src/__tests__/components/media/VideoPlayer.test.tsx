/**
 * VideoPlayer component tests.
 *
 * @vidstack/react and its CSS imports are mocked so no real media infrastructure
 * is needed. Tests assert:
 *   - src / poster / title props are forwarded to the player
 *   - Both seek Gesture zones render with the correct action attributes
 *   - The layout component renders
 *   - The centered play/pause control (issue #236) renders, is labelled for
 *     the current playback state, fades out while playing, and is clickable
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';

// ---------------------------------------------------------------------------
// Mock @vidstack/react — replace heavy browser-media implementation with
// lightweight stubs that emit testable markup.
//
// `paused` drives the mocked `useMediaState('paused')` so tests can render the
// player in either playback state. Hoisted so the vi.mock factory can see it.
// ---------------------------------------------------------------------------

const vds = vi.hoisted(() => ({
  paused: true,
  playButtonClick: vi.fn(),
}));

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

  // Vidstack's PlayButton renders a real <button> and toggles playback
  // internally. The stub keeps the <button> (so role/label/keyboard queries
  // behave the same) and records clicks, which is what lets us assert that our
  // centered element really is the hit target.
  const PlayButton = ({ children, ...rest }: any) => (
    <button type="button" onClick={vds.playButtonClick} {...rest}>
      {children}
    </button>
  );

  const useMediaState = (prop: string) => (prop === 'paused' ? vds.paused : undefined);

  return { MediaPlayer, MediaProvider, Gesture, PlayButton, useMediaState };
});

// Mock the layout + icons sub-package (separate deep import path)
vi.mock('@vidstack/react/player/layouts/default', () => {
  const DefaultVideoLayout = ({ icons: _icons, slots: _slots }: any) => (
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
    vds.paused = true;
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

  // -------------------------------------------------------------------------
  // Centered play/pause control (issue #236)
  // -------------------------------------------------------------------------

  describe('centered play button', () => {
    it('renders a labelled Play button while paused', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      const button = screen.getByRole('button', { name: 'Play video' });
      expect(button).toBeInTheDocument();
      expect(button.tagName).toBe('BUTTON');
    });

    it('switches the accessible label to Pause while playing', () => {
      vds.paused = false;
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      expect(screen.getByRole('button', { name: 'Pause video' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Play video' })).not.toBeInTheDocument();
    });

    it('marks the overlay as paused so the control is shown', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      expect(screen.getByTestId('center-play-overlay')).toHaveAttribute('data-paused', 'true');
    });

    it('marks the overlay as playing so the control is faded out', () => {
      vds.paused = false;
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      expect(screen.getByTestId('center-play-overlay')).toHaveAttribute('data-paused', 'false');
    });

    it('renders the control inside the player, not as a detached overlay', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      const player = screen.getByTestId('media-player');
      expect(player).toContainElement(screen.getByTestId('center-play-overlay'));
    });

    it('toggles playback when clicked', async () => {
      const user = userEvent.setup();
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      await user.click(screen.getByRole('button', { name: 'Play video' }));
      expect(vds.playButtonClick).toHaveBeenCalledTimes(1);
    });

    it('is reachable with the keyboard', async () => {
      const user = userEvent.setup();
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      const button = screen.getByRole('button', { name: 'Play video' });
      await user.tab();
      expect(button).toHaveFocus();
    });

    it('does not replace the double-tap seek zones', () => {
      render(<VideoPlayer src="https://example.com/video.mp4" />);
      // The centered target and both ±10 s zones coexist.
      expect(screen.getByRole('button', { name: 'Play video' })).toBeInTheDocument();
      const actions = screen
        .getAllByTestId('gesture')
        .map((g) => g.getAttribute('data-action'));
      expect(actions).toEqual(expect.arrayContaining(['seek:-10', 'seek:10']));
    });
  });

  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------

  describe('wrapper sizing', () => {
    // jsdom normalises `aspect-ratio` to an unspaced ratio, so these read the
    // computed value rather than going through toHaveStyle.
    it('defaults to a 16:9 wrapper', () => {
      const { container } = render(<VideoPlayer src="https://example.com/video.mp4" />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(getComputedStyle(wrapper).aspectRatio).toBe('16/9');
    });

    it('fills the container instead of forcing 16:9 when `fill` is set', () => {
      const { container } = render(<VideoPlayer src="https://example.com/video.mp4" fill />);
      const wrapper = container.firstElementChild as HTMLElement;
      expect(getComputedStyle(wrapper).height).toBe('100%');
      expect(getComputedStyle(wrapper).aspectRatio).not.toBe('16/9');
    });
  });
});
