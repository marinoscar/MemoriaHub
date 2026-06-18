import { Box } from '@mui/material';
import type { SxProps } from '@mui/material';
import type { BoundingBox } from '../../services/face';

interface FaceCropProps {
  imageUrl: string;
  boundingBox: BoundingBox;  // normalized 0–1 values: x, y, w, h
  size?: number;             // px size of the square crop (default 80)
  sx?: SxProps;
}

/**
 * Renders a face crop from an arbitrary source image using an <img> element
 * approach instead of CSS background-image. This allows the browser to use
 * the full-resolution original so crops are sharp, and enables native lazy
 * loading via loading="lazy".
 *
 * Math:
 *   - Container: overflow:hidden, width/height = size
 *   - Image: positioned absolutely; scaled so that the bounding-box region
 *     fills the container exactly.
 *     width  = 100/w %  (image scaled so bb width maps to container width)
 *     height = 100/h %  (image scaled so bb height maps to container height)
 *     left   = -(x/w)*100 %  (offset so bb left edge aligns with container left)
 *     top    = -(y/h)*100 %  (offset so bb top edge aligns with container top)
 *
 * This is mathematically equivalent to the former CSS background-position approach.
 */
export function FaceCrop({ imageUrl, boundingBox, size = 80, sx }: FaceCropProps) {
  const { x, y, w, h } = boundingBox;

  const imgWidth = `${(100 / w).toFixed(4)}%`;
  const imgHeight = `${(100 / h).toFixed(4)}%`;
  const imgLeft = `${(-(x / w) * 100).toFixed(4)}%`;
  const imgTop = `${(-(y / h) * 100).toFixed(4)}%`;

  return (
    <Box
      role="img"
      aria-label="Face crop"
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        overflow: 'hidden',
        position: 'relative',
        borderRadius: 1,
        bgcolor: 'grey.200',
        ...sx,
      }}
    >
      <Box
        component="img"
        src={imageUrl}
        alt=""
        loading="lazy"
        sx={{
          position: 'absolute',
          width: imgWidth,
          height: imgHeight,
          left: imgLeft,
          top: imgTop,
          display: 'block',
          // Prevent drag events from interfering with click interactions
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      />
    </Box>
  );
}
