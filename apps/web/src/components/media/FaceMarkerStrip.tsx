/**
 * FaceMarkerStrip — a thin timeline strip showing where faces appear in a video.
 *
 * Each tick mark corresponds to one timestamp in face.videoTimestamps.
 * Ticks for the currently-selected face are rendered in primary.main;
 * all others use text.secondary at 50% opacity.
 *
 * Clicking anywhere on the strip seeks the video to that position.
 */

import { Tooltip, Box } from '@mui/material';
import type { DetectedFaceDto } from '../../services/face';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ms: number): string {
  const totalMs = Math.round(ms);
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FaceMarkerStripProps {
  faces: DetectedFaceDto[];
  durationMs: number | null;
  selectedFaceId?: string | null;
  onSeek?: (seconds: number) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FaceMarkerStrip({
  faces,
  durationMs,
  selectedFaceId,
  onSeek,
}: FaceMarkerStripProps) {
  if (!durationMs || durationMs <= 0) return null;

  const handleStripClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, clickX / rect.width));
    onSeek((fraction * durationMs) / 1000);
  };

  return (
    <Box
      onClick={handleStripClick}
      sx={{
        position: 'relative',
        width: '100%',
        height: 20,
        bgcolor: 'action.hover',
        borderRadius: 0.5,
        overflow: 'hidden',
        cursor: onSeek ? 'pointer' : 'default',
        flexShrink: 0,
      }}
      aria-label="Face timeline"
      role="slider"
      aria-valuemin={0}
      aria-valuemax={durationMs}
    >
      {faces.flatMap((face) => {
        const timestamps = face.videoTimestamps;
        if (!timestamps || timestamps.length === 0) return [];
        const isSelected = face.id === selectedFaceId;
        const personLabel = face.personName ?? 'Unassigned';

        return timestamps.map((ts, idx) => {
          const left = (ts / durationMs) * 100;
          const tooltipLabel = `${personLabel} · ${formatTimestamp(ts)}`;

          return (
            <Tooltip key={`${face.id}-${idx}`} title={tooltipLabel} placement="top">
              <Box
                onClick={(e) => {
                  // Let the parent strip handler do the seek; just stop propagation
                  // so the tooltip doesn't interfere.
                  e.stopPropagation();
                  if (onSeek) onSeek(ts / 1000);
                }}
                sx={{
                  position: 'absolute',
                  left: `${left.toFixed(4)}%`,
                  top: 0,
                  width: 2,
                  height: '100%',
                  bgcolor: isSelected ? 'primary.main' : 'text.secondary',
                  opacity: isSelected ? 1 : 0.5,
                  pointerEvents: 'all',
                }}
              />
            </Tooltip>
          );
        });
      })}
    </Box>
  );
}
