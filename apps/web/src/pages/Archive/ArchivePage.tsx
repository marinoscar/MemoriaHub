import { Box, Typography } from '@mui/material';
import { Archive as ArchiveIcon } from '@mui/icons-material';
import { useCircle } from '../../hooks/useCircle';
import { MediaGallery } from '../../components/media/MediaGallery';
import { listArchived } from '../../services/media';

export default function ArchivePage() {
  const { activeCircleId, activeCircleRole } = useCircle();

  if (!activeCircleId) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography color="text.secondary">Select a circle to view archived items.</Typography>
      </Box>
    );
  }

  const circleId = activeCircleId;

  const emptyState = (
    <Box sx={{ textAlign: 'center', py: 10, px: 3 }}>
      <ArchiveIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
      <Typography variant="h6" color="text.secondary">
        Archive is empty
      </Typography>
      <Typography variant="body2" color="text.disabled" sx={{ mt: 1 }}>
        Items you archive will appear here
      </Typography>
    </Box>
  );

  return (
    <Box sx={{ minHeight: 0 }}>
      {/* Page header */}
      <Box sx={{ px: { xs: 2, sm: 3 }, pt: { xs: 2, sm: 3 }, pb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <ArchiveIcon sx={{ color: 'text.secondary' }} />
          <Typography variant="h5" component="h1">
            Archive
          </Typography>
        </Box>
        <Typography variant="body2" color="text.secondary">
          Photos hidden from your main library. They still appear in search results.
        </Typography>
      </Box>

      {/* Gallery (feed mode) */}
      <MediaGallery
        mode="archive"
        circleId={circleId}
        activeCircleRole={activeCircleRole}
        fetcher={(cursor, pageSize) => {
          // Archive is still offset-paginated; encode the page as the cursor.
          const page = cursor ? Number(cursor) : 1;
          return listArchived({ circleId, page, pageSize }).then((r) => ({
            items: r.items,
            nextCursor: page < r.meta.totalPages ? String(page + 1) : null,
          }));
        }}
        queryKey={`archive:${circleId}`}
        emptyState={emptyState}
      />
    </Box>
  );
}
