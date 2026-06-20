import { PieChart } from '@mui/x-charts/PieChart';
import { Box, Typography } from '@mui/material';

interface DonutSegment {
  label: string;
  value: number;       // numeric — raw bytes or count; used for proportions only
  color: string;
  displayValue: string;  // human-readable (e.g. "1.24 GB" or "4,217")
  percentage: number;    // 0-100
}

interface CompositionDonutProps {
  title: string;
  segments: DonutSegment[];
  centerLabel: string;
}

export function CompositionDonut({ title, segments, centerLabel }: CompositionDonutProps) {
  // Guard: if all segments are zero the chart would be empty — render a
  // placeholder ring so the layout never collapses.
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const chartSegments =
    total === 0
      ? [{ id: 0, value: 1, label: 'No data', color: '#e0e0e0' }]
      : segments.map((s, i) => ({ id: i, value: s.value, label: s.label, color: s.color }));

  return (
    <Box sx={{ width: '100%', textAlign: 'center' }}>
      {/* Section title — always centered */}
      <Typography
        variant="subtitle2"
        sx={{ fontWeight: 600, color: 'text.secondary', textAlign: 'center', mb: 1.5 }}
      >
        {title}
      </Typography>

      {/* Fixed-size square container — prevents the SVG from stretching or
          collapsing the outer flex item and guarantees the center overlay
          positions correctly. */}
      <Box sx={{ position: 'relative', width: 180, height: 180, mx: 'auto' }}>
        <PieChart
          series={[
            {
              data: chartSegments,
              innerRadius: 52,
              outerRadius: 80,
              paddingAngle: 2,
              cornerRadius: 3,
            },
          ]}
          width={180}
          height={180}
          hideLegend
          margin={{ top: 0, bottom: 0, left: 0, right: 0 }}
        />
        {/* Centered total overlay */}
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
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', display: 'block', fontSize: '0.65rem', lineHeight: 1 }}
          >
            Total
          </Typography>
          <Typography
            variant="body2"
            sx={{ fontWeight: 700, fontSize: '0.78rem', lineHeight: 1.3 }}
          >
            {centerLabel}
          </Typography>
        </Box>
      </Box>

      {/* Legend — wider container so each row stays on a single line */}
      <Box
        sx={{
          mt: 2,
          maxWidth: 260,
          mx: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 0.75,
        }}
      >
        {segments.map((s) => (
          <Box
            key={s.label}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'nowrap',
              gap: 1,
            }}
          >
            {/* Left: colored dot + label — label truncates if extremely long */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: s.color,
                  flexShrink: 0,
                }}
              />
              <Typography variant="caption" color="text.secondary" noWrap>
                {s.label}
              </Typography>
            </Box>
            {/* Right: value + percentage — never wraps, always on the same line */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                flexShrink: 0,
                whiteSpace: 'nowrap',
              }}
            >
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
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
