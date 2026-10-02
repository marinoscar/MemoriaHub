/**
 * What the phone last reported (issue #515): Synced, Missing, Failed, Blocked,
 * bytes left and a synced/eligible bar. "As of" the device's last check-in,
 * because the phone's ledger, not the server, is authoritative per file.
 */
import { Box, LinearProgress, Typography } from '@mui/material';
import { formatBytes } from '../../../utils/formatBytes';
import { formatCount, formatRelativeTime } from '../../../utils/runFormat';
import { syncCounts, type MediaSyncDevice } from '../../../services/mediaSync';

function Tile({ label, value, testId, emphasis }: { label: string; value: string; testId: string; emphasis?: 'error' | 'warning' }) {
  return (
    <Box
      sx={{
        flex: '1 1 96px',
        minWidth: 0,
        p: 1.5,
        borderRadius: 1,
        border: 1,
        borderColor: 'divider',
      }}
    >
      <Typography variant="caption" color="text.secondary" component="div">
        {label}
      </Typography>
      <Typography
        variant="h6"
        component="div"
        data-testid={testId}
        color={emphasis ? `${emphasis}.main` : 'text.primary'}
        sx={{ overflowWrap: 'anywhere' }}
      >
        {value}
      </Typography>
    </Box>
  );
}

export function SyncCountTiles({ device }: { device: MediaSyncDevice }) {
  const counts = syncCounts(device.stats);
  if (!counts) {
    return (
      <Typography variant="body2" color="text.secondary" data-testid="sync-counts-empty">
        No counts yet. Open the app on your phone once so it can scan its folders.
      </Typography>
    );
  }
  const asOf = device.lastSeenAt ? formatRelativeTime(device.lastSeenAt) : null;
  return (
    <Box data-testid="sync-counts">
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Tile label="Synced" value={formatCount(counts.synced)} testId="count-synced" />
        <Tile label="Missing" value={formatCount(counts.missing)} testId="count-missing" />
        <Tile
          label="Failed"
          value={formatCount(counts.failed)}
          testId="count-failed"
          emphasis={counts.failed > 0 ? 'warning' : undefined}
        />
        <Tile
          label="Blocked"
          value={formatCount(counts.blocked)}
          testId="count-blocked"
          emphasis={counts.blocked > 0 ? 'error' : undefined}
        />
        <Tile
          label="Left to upload"
          value={formatBytes(String(Math.max(0, Math.trunc(counts.bytesPending))))}
          testId="count-bytes-left"
        />
      </Box>
      <Box sx={{ mt: 1.5 }}>
        <LinearProgress
          variant="determinate"
          value={counts.percent ?? 0}
          aria-label="Synced of eligible files"
          sx={{ height: 8, borderRadius: 4 }}
        />
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
          {formatCount(counts.synced)} of {formatCount(counts.eligible)} files synced
          {counts.percent !== null ? ` (${counts.percent}%)` : ''}
          {asOf ? ` · as of ${asOf}` : ''}
        </Typography>
      </Box>
    </Box>
  );
}
