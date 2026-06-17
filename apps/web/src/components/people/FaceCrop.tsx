import { Box } from '@mui/material';
import type { SxProps } from '@mui/material';
import type { BoundingBox } from '../../services/face';

interface FaceCropProps {
  imageUrl: string;
  boundingBox: BoundingBox;  // normalized 0–1 values: x, y, w, h
  size?: number;             // px size of the square crop (default 80)
  sx?: SxProps;
}

export function FaceCrop({ imageUrl, boundingBox, size = 80, sx }: FaceCropProps) {
  const { x, y, w, h } = boundingBox;

  // background-size: if the crop region is w fraction wide,
  // the full image must be (1/w * size) px wide
  const bgWidth = Math.round(size / w);
  const bgHeight = Math.round(size / h);

  // background-position: shift left by (x/w * size) px, up by (y/h * size) px
  const bgX = -Math.round((x / w) * size);
  const bgY = -Math.round((y / h) * size);

  return (
    <Box
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        backgroundImage: `url(${imageUrl})`,
        backgroundSize: `${bgWidth}px ${bgHeight}px`,
        backgroundPosition: `${bgX}px ${bgY}px`,
        backgroundRepeat: 'no-repeat',
        borderRadius: 1,
        bgcolor: 'grey.200',
        ...sx,
      }}
      role="img"
      aria-label="Face crop"
    />
  );
}
