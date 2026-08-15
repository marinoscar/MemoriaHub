import { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Stack,
  Typography,
} from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { useNavigate } from 'react-router-dom';
import { listEnhancementBatches } from '../../services/enhance';
import type { EnhancementBatch } from '../../services/enhance';
import { useIsMounted } from '../../hooks/useIsMounted';
import {
  formatCount,
  formatRelativeTime,
  isTerminalRunStatus,
  runStatusColor,
  runStatusLabel,
} from '../../utils/runFormat';
import { describeParams } from './PendingEnhancementsTab';

/** How many batches the recovery list shows. Recent, not a history tab. */
const RECENT_BATCH_COUNT = 5;

// ---------------------------------------------------------------------------
// Recent bulk-enhance batches (epic #420, issue #423).
//
// The RECOVERY path. The submit toast's "View progress" action is how a user
// normally reaches a batch; this is what they have left after dismissing it or
// reloading the page. Deliberately not a nav entry or a sidebar badge: a batch
// lives for minutes, and the hub's own pending-review badge already counts the
// photos it produces — a second badge would count the same photos twice.
// ---------------------------------------------------------------------------

interface RecentBatchesProps {
  circleId: string;
}

export function RecentBatches({ circleId }: RecentBatchesProps) {
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const [batches, setBatches] = useState<EnhancementBatch[]>([]);

  useEffect(() => {
    let cancelled = false;
    listEnhancementBatches({ circleId, pageSize: RECENT_BATCH_COUNT })
      .then((res) => {
        if (cancelled || !isMounted()) return;
        setBatches(res.items);
      })
      // A failed lookup silently hides the section: this is a convenience list
      // beside the inbox, never the reason the user came to this page.
      .catch(() => {
        if (!cancelled && isMounted()) setBatches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [circleId, isMounted]);

  if (batches.length === 0) return null;

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Recent batches
      </Typography>
      <Stack spacing={1}>
        {batches.map((batch) => {
          const live = !isTerminalRunStatus(batch.status);
          return (
            <Card key={batch.id} variant="outlined">
              <CardActionArea
                onClick={() => navigate(`/enhancement-batches/${batch.id}`)}
                sx={{ minHeight: 44 }}
              >
                <CardContent sx={{ py: 1.5 }}>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}
                  >
                    <AutoFixHighIcon fontSize="small" color={live ? 'primary' : 'disabled'} />
                    <Typography variant="body2" sx={{ minWidth: 0 }}>
                      {formatCount(batch.matchedCount)} photo
                      {batch.matchedCount === 1 ? '' : 's'}
                    </Typography>
                    <Chip
                      size="small"
                      label={runStatusLabel(batch.status)}
                      color={runStatusColor(batch.status)}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {formatRelativeTime(batch.createdAt)}
                    </Typography>
                  </Stack>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mt: 0.5 }}
                  >
                    {describeParams(batch)}
                    {batch.succeededCount > 0
                      ? ` · ${formatCount(batch.succeededCount)} ready to review`
                      : ''}
                    {batch.failedCount > 0
                      ? ` · ${formatCount(batch.failedCount)} failed`
                      : ''}
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          );
        })}
      </Stack>
    </Box>
  );
}
