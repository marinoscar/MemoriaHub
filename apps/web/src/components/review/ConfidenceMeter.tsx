import { Box, Typography, LinearProgress, Tooltip } from '@mui/material';

interface ConfidenceMeterProps {
  /** 0–1 model confidence; null/undefined renders an em dash. */
  confidence: number | null | undefined;
  label?: string;
}

/**
 * Compact confidence meter shared by the burst and duplicate review cards.
 * Color thresholds mirror the burst/duplicate detail quality bars:
 * >= 70% success, >= 40% warning, else error.
 */
export function ConfidenceMeter({ confidence, label = 'Confidence' }: ConfidenceMeterProps) {
  const pct = confidence != null ? Math.round(confidence * 100) : null;

  return (
    <Box sx={{ minWidth: 120, maxWidth: 180 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.25 }}>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {pct != null ? `${pct}%` : '—'}
        </Typography>
      </Box>
      <Tooltip title={pct != null ? `${label}: ${pct}%` : 'No confidence score'}>
        <LinearProgress
          variant="determinate"
          value={pct ?? 0}
          sx={{ height: 4, borderRadius: 2 }}
          color={pct == null ? 'inherit' : pct >= 70 ? 'success' : pct >= 40 ? 'warning' : 'error'}
        />
      </Tooltip>
    </Box>
  );
}
