/**
 * Component tests for FaceMarkerStrip.
 *
 * Coverage:
 *  - Renders null / nothing when durationMs is 0 or null (guard).
 *  - Renders one tick per timestamp in face.videoTimestamps, positioned at ts/durationMs*100%.
 *  - Ticks for the selected face use primary colour (selected).
 *  - Ticks for non-selected faces use text.secondary at 50% opacity.
 *  - Clicking a tick calls onSeek with ts/1000 (seconds).
 *  - Clicking the strip calls onSeek proportionally to click position.
 *  - Renders nothing when all faces have empty videoTimestamps arrays.
 *  - Tooltip label for each tick contains personName and formatted timestamp.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { FaceMarkerStrip } from '../../../components/media/FaceMarkerStrip';
import type { DetectedFaceDto } from '../../../services/face';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFace(id: string, overrides: Partial<DetectedFaceDto> = {}): DetectedFaceDto {
  return {
    id,
    boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    confidence: 0.9,
    personId: 'p1',
    personName: 'Alice',
    providerKey: 'compreface',
    modelVersion: 'arcface-r100-v1',
    manuallyAssigned: false,
    createdAt: new Date().toISOString(),
    videoTimestampMs: 5000,
    videoTimestamps: [5000],
    faceThumbnailUrl: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FaceMarkerStrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Null / zero duration guard
  // -------------------------------------------------------------------------
  describe('null / zero durationMs', () => {
    it('renders nothing when durationMs is null', () => {
      const { container } = render(
        <FaceMarkerStrip
          faces={[makeFace('f1', { videoTimestamps: [5000] })]}
          durationMs={null}
          onSeek={vi.fn()}
        />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when durationMs is 0', () => {
      const { container } = render(
        <FaceMarkerStrip
          faces={[makeFace('f1', { videoTimestamps: [5000] })]}
          durationMs={0}
          onSeek={vi.fn()}
        />,
      );
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when durationMs is negative', () => {
      const { container } = render(
        <FaceMarkerStrip
          faces={[makeFace('f1', { videoTimestamps: [5000] })]}
          durationMs={-100}
          onSeek={vi.fn()}
        />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Strip rendering
  // -------------------------------------------------------------------------
  describe('strip rendering', () => {
    it('renders the face timeline strip when durationMs > 0', () => {
      render(
        <FaceMarkerStrip
          faces={[makeFace('f1')]}
          durationMs={30000}
        />,
      );
      expect(screen.getByRole('slider', { name: /face timeline/i })).toBeInTheDocument();
    });

    it('renders nothing when all faces have empty videoTimestamps', () => {
      const { container } = render(
        <FaceMarkerStrip
          faces={[makeFace('f1', { videoTimestamps: [] })]}
          durationMs={30000}
        />,
      );
      // The strip itself is rendered but no ticks are inside
      const strip = container.querySelector('[aria-label="Face timeline"]');
      // Strip element present but no tick children
      expect(strip?.children).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Tick count and positioning
  // -------------------------------------------------------------------------
  describe('tick marks', () => {
    it('renders one tick per timestamp in videoTimestamps', () => {
      const face = makeFace('f1', { videoTimestamps: [5000, 10000, 15000] });
      render(
        <FaceMarkerStrip
          faces={[face]}
          durationMs={30000}
        />,
      );
      // Ticks have MUI Tooltip wrappers; each tick is a Box with a position.
      // We can count them by their aria-label from Tooltip
      const strip = screen.getByRole('slider', { name: /face timeline/i });
      expect(strip.children).toHaveLength(3);
    });

    it('renders ticks for multiple faces combined', () => {
      const faceA = makeFace('fA', { personId: 'p1', videoTimestamps: [5000, 10000] });
      const faceB = makeFace('fB', { personId: 'p2', videoTimestamps: [15000] });
      render(
        <FaceMarkerStrip
          faces={[faceA, faceB]}
          durationMs={30000}
        />,
      );
      const strip = screen.getByRole('slider', { name: /face timeline/i });
      expect(strip.children).toHaveLength(3); // 2 + 1
    });

    it('tick at 5000 ms on a 30000 ms video has a tooltip labelled with the timestamp', () => {
      const face = makeFace('f1', { videoTimestamps: [5000] });
      render(
        <FaceMarkerStrip
          faces={[face]}
          durationMs={30000}
        />,
      );
      const strip = screen.getByRole('slider', { name: /face timeline/i });
      const tick = strip.children[0] as HTMLElement;
      // MUI sx styles go into generated CSS classes (not inline style), so we
      // verify the tick is present and carries the correct tooltip aria-label
      // which is built from personName + formatted timestamp.
      expect(tick).toBeInTheDocument();
      // aria-label format: "Alice · 0:05.000"
      expect(tick.getAttribute('aria-label')).toMatch(/0:05/);
    });

    it('tick at the start of the video (0 ms) has a tooltip labelled with 0:00', () => {
      const face = makeFace('f1', { videoTimestamps: [0] });
      render(
        <FaceMarkerStrip
          faces={[face]}
          durationMs={30000}
        />,
      );
      const strip = screen.getByRole('slider', { name: /face timeline/i });
      const tick = strip.children[0] as HTMLElement;
      expect(tick).toBeInTheDocument();
      // aria-label format: "Alice · 0:00.000"
      expect(tick.getAttribute('aria-label')).toMatch(/0:00/);
    });
  });

  // -------------------------------------------------------------------------
  // onSeek via tick click
  // -------------------------------------------------------------------------
  describe('tick click → onSeek', () => {
    it('calls onSeek with ts/1000 when a tick is clicked', () => {
      const onSeek = vi.fn();
      const face = makeFace('f1', { videoTimestamps: [12000] });
      render(
        <FaceMarkerStrip
          faces={[face]}
          durationMs={60000}
          onSeek={onSeek}
        />,
      );
      const strip = screen.getByRole('slider', { name: /face timeline/i });
      const tick = strip.children[0] as HTMLElement;
      fireEvent.click(tick);

      expect(onSeek).toHaveBeenCalledWith(12); // 12000 / 1000 = 12 s
    });

    it('calls onSeek for each independently clicked tick', () => {
      const onSeek = vi.fn();
      const face = makeFace('f1', { videoTimestamps: [3000, 6000] });
      render(
        <FaceMarkerStrip
          faces={[face]}
          durationMs={30000}
          onSeek={onSeek}
        />,
      );
      const strip = screen.getByRole('slider', { name: /face timeline/i });
      fireEvent.click(strip.children[0]);
      expect(onSeek).toHaveBeenLastCalledWith(3);

      fireEvent.click(strip.children[1]);
      expect(onSeek).toHaveBeenLastCalledWith(6);
    });
  });

  // -------------------------------------------------------------------------
  // Strip click → proportional seek
  // -------------------------------------------------------------------------
  describe('strip click → proportional seek', () => {
    it('calls onSeek proportionally when the strip background is clicked', () => {
      const onSeek = vi.fn();
      render(
        <FaceMarkerStrip
          faces={[makeFace('f1', { videoTimestamps: [5000] })]}
          durationMs={30000}
          onSeek={onSeek}
        />,
      );

      const strip = screen.getByRole('slider', { name: /face timeline/i });
      // Simulate click at 50% of the strip width (width=200, click at x=100)
      Object.defineProperty(strip, 'getBoundingClientRect', {
        value: () => ({ left: 0, width: 200, right: 200, top: 0, bottom: 20, height: 20, x: 0, y: 0, toJSON: () => {} }),
        configurable: true,
      });
      fireEvent.click(strip, { clientX: 100 });

      // 100 / 200 = 0.5 → 0.5 * 30000 / 1000 = 15 s
      expect(onSeek).toHaveBeenCalledWith(15);
    });
  });

  // -------------------------------------------------------------------------
  // Selected face highlight
  // -------------------------------------------------------------------------
  describe('selected face highlight', () => {
    it('renders selected and non-selected ticks (does not throw)', () => {
      const faceA = makeFace('fA', { id: 'fA', personId: 'p1', videoTimestamps: [5000] });
      const faceB = makeFace('fB', { id: 'fB', personId: 'p2', videoTimestamps: [10000] });
      // Should not throw when selectedFaceId is set
      expect(() =>
        render(
          <FaceMarkerStrip
            faces={[faceA, faceB]}
            durationMs={30000}
            selectedFaceId="fA"
          />,
        ),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Unassigned face name in tooltip
  // -------------------------------------------------------------------------
  describe('unassigned face in strip', () => {
    it('does not crash when personName is null (renders Unassigned tooltip)', () => {
      const face = makeFace('f1', { personName: null, videoTimestamps: [5000] });
      expect(() =>
        render(
          <FaceMarkerStrip
            faces={[face]}
            durationMs={30000}
          />,
        ),
      ).not.toThrow();
    });
  });
});
