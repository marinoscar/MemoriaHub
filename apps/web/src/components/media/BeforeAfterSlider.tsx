import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Dialog,
  IconButton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  CircularProgress,
} from '@mui/material';
import {
  Close as CloseIcon,
  CompareArrows as CompareArrowsIcon,
  ViewColumn as ViewColumnIcon,
  OpenInFull as OpenInFullIcon,
} from '@mui/icons-material';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type CompareMode = 'slider' | 'side-by-side';

export interface BeforeAfterSliderProps {
  /** URL of the "before" (original) image. `null` renders a spinner. */
  beforeUrl: string | null;
  /** URL of the "after" (enhanced) image. `null` renders a spinner. */
  afterUrl: string | null;
  /** Label for the before side. Defaults to "Before". */
  beforeLabel?: string;
  /** Label for the after side. Defaults to "After". */
  afterLabel?: string;
  /**
   * Intrinsic dimensions. Used only to size the compare frame to the photo's
   * aspect ratio so the divider travels across the IMAGE rather than across
   * the letterbox bars of a fixed-height box.
   */
  beforeWidth?: number | null;
  beforeHeight?: number | null;
  afterWidth?: number | null;
  afterHeight?: number | null;
  /** Height of the image stage. Accepts an MUI responsive value. */
  height?: number | { xs: number; sm?: number; md?: number };
  /**
   * When true (default) the stage is tappable and offers a "View larger"
   * button that opens a full-screen copy of this same component. The
   * full-screen copy passes `false` so it cannot recurse.
   */
  zoomable?: boolean;
}

const HANDLE_SIZE = 44; // touch-target floor

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(0, n));
}

/** Small translucent corner label. */
function SideLabel({ text, side }: { text: string; side: 'left' | 'right' }) {
  return (
    <Typography
      variant="caption"
      sx={{
        position: 'absolute',
        top: 8,
        [side]: 8,
        px: 1,
        py: 0.25,
        borderRadius: 1,
        bgcolor: 'rgba(0,0,0,0.62)',
        color: '#fff',
        fontWeight: 600,
        letterSpacing: 0.3,
        pointerEvents: 'none',
        zIndex: 3,
      }}
    >
      {text}
    </Typography>
  );
}

function Layer({ url, alt }: { url: string | null; alt: string }) {
  if (!url) {
    return (
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <CircularProgress size={22} />
      </Box>
    );
  }
  return (
    <Box
      component="img"
      src={url}
      alt={alt}
      draggable={false}
      sx={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        userSelect: 'none',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Purely presentational before/after comparison. No data fetching — the caller
 * owns the URLs.
 *
 * Two view modes:
 *  - `slider` — both images are stacked in the same frame and the BEFORE image
 *    is clipped to the left of a draggable vertical divider. This is the
 *    standard photo-editing compare gesture and is best for local detail.
 *  - `side-by-side` — the two images next to each other, better for judging
 *    global color/brightness where a moving seam is distracting.
 *
 * Divider interaction model:
 *  - mouse + touch + pen through Pointer Events; the frame sets
 *    `touchAction: 'none'` so a vertical page scroll can't steal the drag,
 *  - keyboard on the handle: ←/→ ±2%, PageDown/PageUp ±10%, Home/End to the
 *    ends — exposed as `role="slider"` with aria-valuemin/max/now/text,
 *  - a short, near-stationary press on the frame is treated as a tap and opens
 *    the full-screen view; a press that moves is a drag and does not.
 */
export function BeforeAfterSlider({
  beforeUrl,
  afterUrl,
  beforeLabel = 'Before',
  afterLabel = 'After',
  beforeWidth,
  beforeHeight,
  afterWidth,
  afterHeight,
  height = { xs: 260, sm: 400 },
  zoomable = true,
}: BeforeAfterSliderProps) {
  const [mode, setMode] = useState<CompareMode>('slider');
  const [pos, setPos] = useState(50);
  const [zoomOpen, setZoomOpen] = useState(false);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  // Distinguishes a tap (open zoom) from a drag (move the divider).
  const downRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const setFromClientX = useCallback((clientX: number) => {
    const el = frameRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    setPos(clampPct(((clientX - rect.left) / rect.width) * 100));
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      downRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
      draggingRef.current = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* unsupported (jsdom) — window listeners below still end the drag */
      }
      setFromClientX(e.clientX);
    },
    [setFromClientX],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      setFromClientX(e.clientX);
    },
    [setFromClientX],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = false;
      const down = downRef.current;
      downRef.current = null;
      if (!zoomable || !down) return;
      const moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
      if (moved < 6 && Date.now() - down.t < 400) setZoomOpen(true);
    },
    [zoomable],
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    let delta = 0;
    if (e.key === 'ArrowLeft') delta = -2;
    else if (e.key === 'ArrowRight') delta = 2;
    else if (e.key === 'PageDown') delta = -10;
    else if (e.key === 'PageUp') delta = 10;
    else if (e.key === 'Home') {
      e.preventDefault();
      setPos(0);
      return;
    } else if (e.key === 'End') {
      e.preventDefault();
      setPos(100);
      return;
    } else {
      return;
    }
    e.preventDefault();
    setPos((p) => clampPct(p + delta));
  }, []);

  // A pointer released outside the frame must not leave us stuck in "dragging".
  useEffect(() => {
    const stop = () => {
      draggingRef.current = false;
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  const ratio =
    beforeWidth && beforeHeight
      ? beforeWidth / beforeHeight
      : afterWidth && afterHeight
        ? afterWidth / afterHeight
        : null;

  const stageSx = {
    position: 'relative' as const,
    width: '100%',
    height,
    bgcolor: 'common.black',
    borderRadius: 1,
    border: '1px solid',
    borderColor: 'divider',
    overflow: 'hidden',
  };

  const sliderStage = (
    <Box
      sx={{
        ...stageSx,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Frame sized to the photo's aspect ratio so the divider tracks the
          image, not the surrounding letterbox. */}
      <Box
        ref={frameRef}
        data-testid="before-after-frame"
        sx={{
          position: 'relative',
          height: '100%',
          width: ratio ? 'auto' : '100%',
          aspectRatio: ratio ? String(ratio) : undefined,
          maxWidth: '100%',
          touchAction: 'none',
          cursor: zoomable ? 'zoom-in' : 'ew-resize',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* After (base layer) */}
        <Layer url={afterUrl} alt={afterLabel} />

        {/* Before, clipped to the left of the divider */}
        <Box sx={{ position: 'absolute', inset: 0, clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
          <Layer url={beforeUrl} alt={beforeLabel} />
        </Box>

        <SideLabel text={beforeLabel} side="left" />
        <SideLabel text={afterLabel} side="right" />

        {/* Divider line */}
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${pos}%`,
            width: 2,
            ml: '-1px',
            bgcolor: '#fff',
            boxShadow: '0 0 4px rgba(0,0,0,0.6)',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />

        {/* Draggable / focusable handle */}
        <Box
          role="slider"
          tabIndex={0}
          aria-label={`${beforeLabel} and ${afterLabel} comparison position`}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pos)}
          aria-valuetext={`${Math.round(pos)}% ${beforeLabel.toLowerCase()}`}
          onKeyDown={handleKeyDown}
          // The frame already handles pointer drags; keep a press on the handle
          // itself from also registering as a tap-to-zoom.
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => {
            if (e.buttons === 1) {
              e.stopPropagation();
              setFromClientX(e.clientX);
            }
          }}
          onClick={(e) => e.stopPropagation()}
          sx={{
            position: 'absolute',
            top: '50%',
            left: `${pos}%`,
            transform: 'translate(-50%, -50%)',
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
            borderRadius: '50%',
            bgcolor: '#fff',
            color: 'rgba(0,0,0,0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 3,
            cursor: 'ew-resize',
            zIndex: 4,
            touchAction: 'none',
            '&:focus-visible': {
              outline: '3px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2,
            },
          }}
        >
          <CompareArrowsIcon fontSize="small" />
        </Box>
      </Box>
    </Box>
  );

  const sideBySideStage = (
    <Stack direction="row" spacing={1}>
      {[
        { url: beforeUrl, label: beforeLabel },
        { url: afterUrl, label: afterLabel },
      ].map(({ url, label }, i) => (
        <Box
          key={label}
          sx={{ ...stageSx, flex: 1, minWidth: 0, cursor: zoomable ? 'zoom-in' : 'default' }}
          onClick={zoomable ? () => setZoomOpen(true) : undefined}
        >
          <Layer url={url} alt={label} />
          <SideLabel text={label} side={i === 0 ? 'left' : 'right'} />
        </Box>
      ))}
    </Stack>
  );

  return (
    <Box>
      <Stack
        direction="row"
        spacing={1}
        sx={{ mb: 1, alignItems: 'center', justifyContent: 'space-between' }}
      >
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_e, v: CompareMode | null) => {
            if (v) setMode(v);
          }}
          aria-label="Comparison view"
        >
          <ToggleButton
            value="slider"
            aria-label="Slider comparison"
            sx={{ minHeight: 36, px: 1.25 }}
          >
            <CompareArrowsIcon fontSize="small" sx={{ mr: 0.5 }} />
            Slider
          </ToggleButton>
          <ToggleButton
            value="side-by-side"
            aria-label="Side by side comparison"
            sx={{ minHeight: 36, px: 1.25 }}
          >
            <ViewColumnIcon fontSize="small" sx={{ mr: 0.5 }} />
            Side by side
          </ToggleButton>
        </ToggleButtonGroup>

        {zoomable && (
          <Tooltip title="View larger">
            <IconButton
              onClick={() => setZoomOpen(true)}
              aria-label="View larger"
              size="small"
              sx={{ minWidth: 44, minHeight: 44 }}
            >
              <OpenInFullIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      {mode === 'slider' ? sliderStage : sideBySideStage}

      {mode === 'slider' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
          Drag the handle — or focus it and use the arrow keys — to compare.
          {zoomable ? ' Tap the photo to view it larger.' : ''}
        </Typography>
      )}

      {zoomable && (
        <Dialog
          fullScreen
          open={zoomOpen}
          onClose={() => setZoomOpen(false)}
          aria-label={`${beforeLabel} and ${afterLabel} full screen comparison`}
          sx={{ zIndex: (t) => t.zIndex.modal + 4 }}
        >
          <Box
            sx={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              bgcolor: 'background.default',
              p: { xs: 1, sm: 2 },
            }}
          >
            <Stack direction="row" sx={{ mb: 1, alignItems: 'center' }}>
              <IconButton
                onClick={() => setZoomOpen(false)}
                aria-label="Close comparison"
                sx={{ minWidth: 44, minHeight: 44 }}
              >
                <CloseIcon />
              </IconButton>
              <Typography variant="subtitle1" sx={{ ml: 1 }}>
                {beforeLabel} vs {afterLabel}
              </Typography>
            </Stack>
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <BeforeAfterSlider
                beforeUrl={beforeUrl}
                afterUrl={afterUrl}
                beforeLabel={beforeLabel}
                afterLabel={afterLabel}
                beforeWidth={beforeWidth}
                beforeHeight={beforeHeight}
                afterWidth={afterWidth}
                afterHeight={afterHeight}
                height={{ xs: 420, sm: 620 }}
                zoomable={false}
              />
            </Box>
          </Box>
        </Dialog>
      )}
    </Box>
  );
}

export default BeforeAfterSlider;
