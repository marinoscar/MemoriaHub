import React from 'react';
import { Box, Typography } from '@mui/material';

interface Segment {
  label: string;
  value: number;   // percentage 0-100
  color: string;
  displayValue: string;
}

interface ProportionBarProps {
  segments: Segment[];
  caption?: string;
}

export function ProportionBar({ segments, caption }: ProportionBarProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return null;

  return (
    <Box>
      {/* Legend row */}
      <Box display="flex" gap={3} mb={1} flexWrap="wrap">
        {segments.map((s) => (
          <Box key={s.label} display="flex" alignItems="center" gap={0.75}>
            <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: s.color, flexShrink: 0 }} />
            <Typography variant="caption" color="text.secondary">
              {s.label}
            </Typography>
            <Typography variant="caption" fontWeight={600}>
              {s.displayValue}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              ({s.value.toFixed(1)}%)
            </Typography>
          </Box>
        ))}
      </Box>
      {/* Bar */}
      <Box display="flex" height={10} borderRadius={1} overflow="hidden" bgcolor="action.hover">
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
      {caption && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
          {caption}
        </Typography>
      )}
    </Box>
  );
}
