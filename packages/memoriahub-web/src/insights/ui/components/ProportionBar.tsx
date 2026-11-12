import { Box, Typography } from '@mui/material';

/**
 * One segment of a {@link ProportionBar}.
 *
 * @stability experimental
 */
export interface ProportionSegment {
  label: string;
  value: number;   // percentage 0-100
  color: string;
  // displayValue intentionally omitted — MB values are shown in the donut legend
}

/**
 * The props of {@link ProportionBar}.
 *
 * @stability experimental
 */
export interface ProportionBarProps {
  segments: ProportionSegment[];
  caption?: string;
}

/**
 * A single stacked bar of proportions with an optional caption; renders nothing when every segment is zero.
 *
 * @param props - see {@link ProportionBarProps}
 * @returns the bar, or `null`
 * @stability experimental
 */
export function ProportionBar({ segments, caption }: ProportionBarProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return null;

  return (
    <Box>
      {/* Section caption above the bar */}
      {caption && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mb: 1, display: 'block' }}
        >
          {caption}
        </Typography>
      )}

      {/* Prominent bar — 16px height, rounded ends, themed track */}
      <Box
        sx={{
          display: 'flex',
          height: 16,
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: 'action.hover',
        }}
      >
        {segments.map((s) => (
          <Box
            key={s.label}
            sx={{
              width: `${(s.value / total) * 100}%`,
              bgcolor: s.color,
              transition: 'width 0.4s ease',
            }}
          />
        ))}
      </Box>

      {/* Compact percent-only caption row — no MB duplication */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2.5,
          mt: 1,
          flexWrap: 'wrap',
        }}
      >
        {segments.map((s) => (
          <Box
            key={s.label}
            sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}
          >
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: s.color,
                flexShrink: 0,
              }}
            />
            <Typography variant="caption" color="text.secondary">
              {s.label}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {s.value.toFixed(1)}%
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
