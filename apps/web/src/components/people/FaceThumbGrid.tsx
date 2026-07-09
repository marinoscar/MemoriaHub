import { useState, useEffect } from 'react';
import { Box, Grid, Checkbox } from '@mui/material';
import { FaceCrop } from './FaceCrop';
import type { UnassignedFaceDto } from '../../services/face';
import { getMedia } from '../../services/media';

/**
 * Renders a selectable grid of face thumbnails, resolving each face's media
 * thumbnail URL on demand. Used by both the live unassigned pool and the
 * archived faces sub-view.
 */
export function FaceThumbGrid({
  faces,
  selectedIds,
  onToggle,
}: {
  faces: UnassignedFaceDto[];
  selectedIds: Set<string>;
  onToggle: (faceId: string) => void;
}) {
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});

  // Resolve thumbnail URLs for each unique mediaItemId
  useEffect(() => {
    if (faces.length === 0) return;
    const uniqueIds = [...new Set(faces.map((f) => f.mediaItemId))];
    const missing = uniqueIds.filter((id) => !mediaUrls[id]);
    if (missing.length === 0) return;
    missing.forEach((mediaId) => {
      getMedia(mediaId)
        .then((item) => {
          const url = item.downloadUrl ?? item.thumbnailUrl;
          if (url) {
            setMediaUrls((prev) => ({ ...prev, [mediaId]: url }));
          }
        })
        .catch(() => undefined);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faces]);

  return (
    <Grid container spacing={1}>
      {faces.map((face) => {
        const imgUrl = mediaUrls[face.mediaItemId];
        const selected = selectedIds.has(face.faceId);
        return (
          <Grid key={face.faceId}>
            <Box
              onClick={() => onToggle(face.faceId)}
              sx={{
                position: 'relative',
                cursor: 'pointer',
                borderRadius: 1,
                border: selected ? '2px solid' : '2px solid transparent',
                borderColor: selected ? 'primary.main' : 'transparent',
                '&:hover': { borderColor: 'primary.light' },
              }}
            >
              {face.faceThumbnailUrl ? (
                <Box
                  component="img"
                  src={face.faceThumbnailUrl}
                  sx={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 1, display: 'block' }}
                />
              ) : imgUrl ? (
                <FaceCrop imageUrl={imgUrl} boundingBox={face.boundingBox} size={72} />
              ) : (
                <Box sx={{ width: 72, height: 72, bgcolor: 'grey.200', borderRadius: 1 }} />
              )}
              <Checkbox
                size="small"
                checked={selected}
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  p: 0.25,
                  color: 'white',
                  '&.Mui-checked': { color: 'primary.main' },
                }}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggle(face.faceId)}
              />
            </Box>
          </Grid>
        );
      })}
    </Grid>
  );
}
