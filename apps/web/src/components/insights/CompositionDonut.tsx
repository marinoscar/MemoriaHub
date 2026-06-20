import React from 'react';
import { PieChart } from '@mui/x-charts/PieChart';
import { Box, Typography } from '@mui/material';

interface DonutSegment {
  label: string;
  value: number;    // numeric (e.g. MB or count)
  color: string;
  displayValue: string;  // formatted for legend (e.g. "1.24 GB" or "4,217")
  percentage: number;    // 0-100
}

interface CompositionDonutProps {
  title: string;
  segments: DonutSegment[];
  centerLabel: string;
}

export function CompositionDonut({ title, segments, centerLabel }: CompositionDonutProps) {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography variant="subtitle2" fontWeight={600} color="text.secondary" mb={1}>
        {title}
      </Typography>
      {/* Donut chart with centered label */}
      <Box sx={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
        <PieChart
          series={[
            {
              data: segments.map((s, i) => ({ id: i, value: s.value, label: s.label, color: s.color })),
              innerRadius: 55,
              outerRadius: 85,
              paddingAngle: 2,
              cornerRadius: 3,
            },
          ]}
          width={200}
          height={200}
          slotProps={{ legend: { hidden: true } }}
          margin={{ top: 0, bottom: 0, left: 0, right: 0 }}
        />
        {/* Centered total label */}
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          <Typography variant="caption" color="text.secondary" display="block" sx={{ fontSize: '0.65rem', lineHeight: 1 }}>
            Total
          </Typography>
          <Typography variant="body2" fontWeight={700} sx={{ fontSize: '0.78rem', lineHeight: 1.3 }}>
            {centerLabel}
          </Typography>
        </Box>
      </Box>
      {/* Custom legend */}
      <Box sx={{ mt: 1.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {segments.map((s) => (
          <Box key={s.label} display="flex" alignItems="center" justifyContent="space-between">
            <Box display="flex" alignItems="center" gap={1}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: s.color, flexShrink: 0 }} />
              <Typography variant="caption" color="text.secondary">
                {s.label}
              </Typography>
            </Box>
            <Box display="flex" gap={1} alignItems="center">
              <Typography variant="caption" fontWeight={600}>
                {s.displayValue}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {s.percentage.toFixed(1)}%
              </Typography>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
