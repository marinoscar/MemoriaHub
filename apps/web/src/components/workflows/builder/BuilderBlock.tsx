import type { ReactNode } from 'react';
import { Paper, Box, Typography, Chip } from '@mui/material';

// ---------------------------------------------------------------------------
// BuilderBlock — the stacked, full-width IFTTT-style card used for every
// builder section (Subject · Trigger · If · Then · Safety). A bold keyword
// label ("ON", "WHEN", "IF", "THEN") anchors the top-to-bottom reading order.
// ---------------------------------------------------------------------------

export interface BuilderBlockProps {
  /** Short uppercase keyword, e.g. "ON", "WHEN", "IF", "THEN". */
  keyword: string;
  title: string;
  subtitle?: ReactNode;
  /** Optional accent color for the keyword chip. */
  color?: 'primary' | 'secondary' | 'info' | 'success' | 'warning' | 'default';
  children: ReactNode;
  /** Optional trailing element (e.g. a match toggle) rendered in the header row. */
  action?: ReactNode;
}

export function BuilderBlock({
  keyword,
  title,
  subtitle,
  color = 'primary',
  children,
  action,
}: BuilderBlockProps) {
  return (
    <Paper
      variant="outlined"
      sx={{ p: { xs: 2, md: 3 }, borderRadius: 2, width: '100%' }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 2,
          mb: 2,
          flexWrap: 'wrap',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
          <Chip
            label={keyword}
            color={color === 'default' ? undefined : color}
            size="small"
            sx={{ fontWeight: 700, letterSpacing: 0.5, borderRadius: 1 }}
          />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
              {title}
            </Typography>
            {subtitle && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                {subtitle}
              </Typography>
            )}
          </Box>
        </Box>
        {action && <Box sx={{ flexShrink: 0 }}>{action}</Box>}
      </Box>
      {children}
    </Paper>
  );
}
