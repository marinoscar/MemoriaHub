import React from 'react';
import { Box, Typography } from '@mui/material';

interface Segment {
  label: string;
  value: number;   // percentage 0-100
  color: string;
  // displayValue intentionally omitted — MB values are shown in the donut legend
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
