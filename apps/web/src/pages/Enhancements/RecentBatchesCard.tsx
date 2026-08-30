import { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Chip,
  Divider,
  Link,
  Stack,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { listEnhancementBatches, type EnhancementBatch } from '../../services/enhance';
import {
  formatCount,
  formatRelativeTime,
  isTerminalRunStatus,
  runStatusColor,
  runStatusLabel,
} from '../../utils/runFormat';

/** How many batches the hub surfaces. Enough to find one, not a history page. */
const RECENT_LIMIT = 3;

// ---------------------------------------------------------------------------
// Recent bulk-enhance batches (epic #420, issue #423).
//
// The RECOVERY path back to a batch. The submit toast's "View progress" action
// is the main one; this exists for the user who dismissed it, reloaded, or came
// back tomorrow — without it a batch id is unrecoverable from the UI once the
// toast is gone.
//
// Deliberately not a nav entry and not a badge: a batch is transient (minutes),
// and the hub already carries the `pendingEnhancements` badge, which rises as a
// batch produces results. A second badge would count the same photos twice.
// ---------------------------------------------------------------------------

interface RecentBatchesCardProps {
  circleId: string;
}

/** One line per batch: when, what state, and how far along. */
function BatchRow({ batch }: { batch: EnhancementBatch }) {
  const terminal = isTerminalRunStatus(batch.status);
  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      sx={{ alignItems: 'center', flexWrap: 'wrap', py: 0.75 }}
    >
      <Link
        component={RouterLink}
        to={`/enhancement-batches/${batch.id}`}
        variant="body2"
        underline="hover"
      >
        {formatCount(batch.matchedCount)} photo
        {batch.matchedCount === 1 ? '' : 's'}
      </Link>
      <Chip
        size="small"
        label={runStatusLabel(batch.status)}
        color={runStatusColor(batch.status)}
      />
      <Typography variant="caption" color="text.secondary">
        {terminal
          ? `${formatCount(batch.succeededCount)} ready to review`
          : `${formatCount(batch.processedCount)} of ${formatCount(batch.matchedCount)} done`}
        {' · '}
        {formatRelativeTime(batch.createdAt)}
      </Typography>
    </Stack>
  );
}

export function RecentBatchesCard({ circleId }: RecentBatchesCardProps) {
  const [batches, setBatches] = useState<EnhancementBatch[]>([]);

  // Best-effort: this is a convenience pointer, not the tab's data. A failure
  // here must never put an error banner over an otherwise-working inbox, so it
  // renders nothing rather than reporting.
  useEffect(() => {
    let cancelled = false;
    listEnhancementBatches({ circleId, page: 1, pageSize: RECENT_LIMIT })
      .then((res) => {
        if (!cancelled) setBatches(res.items);
      })
      .catch(() => {
        if (!cancelled) setBatches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [circleId]);

  if (batches.length === 0) return null;

  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          Recent batches
        </Typography>
        <Box>
          {batches.map((batch, index) => (
            <Box key={batch.id}>
              {index > 0 && <Divider />}
              <BatchRow batch={batch} />
            </Box>
          ))}
        </Box>
      </CardContent>
    </Card>
  );
}
