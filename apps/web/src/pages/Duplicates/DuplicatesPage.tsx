import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Badge,
  Stack,
  Pagination,
} from '@mui/material';
import { ContentCopy as ContentCopyIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { useDuplicateGroups } from '../../hooks/useDuplicates';
import type { DuplicateGroupKind, DuplicateGroupSummary } from '../../services/duplicates';

const KIND_LABELS: Record<DuplicateGroupKind, string> = {
  exact_variant: 'Exact copy',
  edited: 'Edited variant',
  similar: 'Similar',
};

const KIND_COLORS: Record<DuplicateGroupKind, 'default' | 'success' | 'warning' | 'info'> = {
  exact_variant: 'success',
  edited: 'warning',
  similar: 'info',
};

const KIND_FILTERS: Array<{ label: string; value: DuplicateGroupKind | null }> = [
  { label: 'All', value: null },
  { label: 'Exact copy', value: 'exact_variant' },
  { label: 'Edited variant', value: 'edited' },
  { label: 'Similar', value: 'similar' },
];

function CoverStack({ coverUrls, mediaCount }: { coverUrls: string[]; mediaCount: number }) {
  return (
    <Box sx={{ position: 'relative', width: 120, height: 90, flexShrink: 0 }}>
      {coverUrls.slice(0, 3).map((url, i) => (
        <Box
          key={i}
          component="img"
          src={url}
          alt=""
          sx={{
            position: 'absolute',
            top: i * 4,
            left: i * 4,
            width: 100,
            height: 80,
            objectFit: 'cover',
            borderRadius: 1,
            border: '2px solid',
            borderColor: 'background.paper',
            boxShadow: 1,
            zIndex: coverUrls.length - i,
          }}
        />
      ))}
      <Badge
        badgeContent={mediaCount}
        color="primary"
        sx={{ position: 'absolute', top: 2, right: 2, zIndex: 10 }}
      />
    </Box>
  );
}

function DuplicateGroupCard({ group }: { group: DuplicateGroupSummary }) {
  const navigate = useNavigate();

  const capturedDate = group.capturedAt
    ? new Date(group.capturedAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  return (
    <Card variant="outlined">
      <CardActionArea
        onClick={() => navigate(`/duplicates/${group.id}`)}
        sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 2, justifyContent: 'flex-start' }}
      >
        <CoverStack coverUrls={group.coverThumbnailUrls} mediaCount={group.mediaCount} />
        <CardContent sx={{ flex: 1, p: 0, '&:last-child': { pb: 0 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
            <Typography variant="subtitle2" component="span">
              {group.mediaCount} photos
            </Typography>
            <Chip
              label={KIND_LABELS[group.kind]}
              size="small"
              color={KIND_COLORS[group.kind]}
              variant="outlined"
            />
          </Box>
          {capturedDate && (
            <Typography variant="body2" color="text.secondary">
              {capturedDate}
            </Typography>
          )}
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default function DuplicatesPage() {
  const { activeCircle, activeCircleId } = useCircle();
  const { items, meta, isLoading, error, fetchGroups } = useDuplicateGroups();
  const [kindFilter, setKindFilter] = useState<DuplicateGroupKind | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!activeCircleId) return;
    void fetchGroups({
      circleId: activeCircleId,
      status: 'pending',
      kind: kindFilter ?? undefined,
      page,
    });
  }, [activeCircleId, kindFilter, page, fetchGroups]);

  useEffect(() => {
    setPage(1);
  }, [kindFilter, activeCircleId]);

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to review duplicate photos.</Alert>
      </Box>
    );
  }

  const pageCount = meta ? Math.max(1, Math.ceil(meta.total / meta.pageSize)) : 1;

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 3, gap: 1 }}>
        <ContentCopyIcon color="primary" />
        <Typography variant="h5" component="h1">
          Review Duplicates
        </Typography>
      </Box>

      {/* Kind filter chips */}
      <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 1 }}>
        {KIND_FILTERS.map((f) => (
          <Chip
            key={f.label}
            label={f.label}
            size="small"
            color={kindFilter === f.value ? 'primary' : 'default'}
            variant={kindFilter === f.value ? 'filled' : 'outlined'}
            onClick={() => setKindFilter(f.value)}
          />
        ))}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      )}

      {!isLoading && items.length === 0 && !error && (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <ContentCopyIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 2 }} />
          <Typography variant="h6" color="text.secondary" gutterBottom>
            No duplicate groups to review
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Near-duplicate photos — like recompressed re-shares — are grouped here for review.
          </Typography>
        </Box>
      )}

      {!isLoading && items.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {meta?.total ?? items.length} duplicate group{(meta?.total ?? items.length) !== 1 ? 's' : ''} pending review
          </Typography>
          {items.map((group) => (
            <DuplicateGroupCard key={group.id} group={group} />
          ))}
          {pageCount > 1 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
              <Pagination count={pageCount} page={page} onChange={(_, p) => setPage(p)} color="primary" />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
