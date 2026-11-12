import { Box, Chip, Typography } from '@mui/material';
import { relativeTime } from '../../../core/headless/index.js';

/**
 * The props of {@link FreshnessPill}.
 *
 * @stability experimental
 */
export interface FreshnessPillProps {
  computedAt: string | null;
  durationMs: number | null;
}

// Treat snapshots older than 4 hours as stale (matches default refresh interval)
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000;

/**
 * A chip saying how old a precomputed snapshot is (stale past four hours) and how long it took to compute.
 *
 * @param props - see {@link FreshnessPillProps}
 * @returns the pill
 * @stability experimental
 */
export function FreshnessPill({ computedAt, durationMs }: FreshnessPillProps) {
  if (!computedAt) {
    return (
      <Chip
        size="small"
        label="No data yet"
        color="default"
        sx={{ fontWeight: 500 }}
      />
    );
  }

  const age = Date.now() - new Date(computedAt).getTime();
  const isStale = age > STALE_THRESHOLD_MS;
  const rel = relativeTime(computedAt);
  const duration = durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : null;

  return (
    <Box sx={{ textAlign: 'right' }}>
      <Chip
        size="small"
        label={`Updated ${rel}`}
        color={isStale ? 'warning' : 'success'}
        variant="outlined"
        sx={{ fontWeight: 500 }}
      />
      {duration && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.25 }}>
          computed in {duration}
        </Typography>
      )}
    </Box>
  );
}
