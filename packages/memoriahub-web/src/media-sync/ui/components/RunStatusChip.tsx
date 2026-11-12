import { Chip } from '@mui/material';
import type { MediaSyncRunStatus } from '../../headless/services/mediaSync.js';
import { RUN_STATUS_COLORS, RUN_STATUS_LABELS } from './format.js';

/**
 * A sync run's status as a small coloured chip.
 *
 * @stability experimental
 */
export function RunStatusChip({ status }: { status: MediaSyncRunStatus }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      color={RUN_STATUS_COLORS[status] ?? 'default'}
      label={RUN_STATUS_LABELS[status] ?? status}
      data-testid={`run-status-${status}`}
    />
  );
}
