import React from 'react';
import { Card, CardContent, Typography, Box, alpha } from '@mui/material';

interface KpiCardProps {
  label: string;       // displayed in UPPERCASE caption
  value: string;       // large primary display
  subLabel?: string;
  icon: React.ReactNode;
  accentColor: string;
}

export function KpiCard({ label, value, subLabel, icon, accentColor }: KpiCardProps) {
  return (
    <Card
      variant="outlined"
      sx={{
        borderTop: `3px solid ${accentColor}`,
        borderRadius: 2,
        transition: 'box-shadow 0.2s',
        '&:hover': { boxShadow: 4 },
        height: '100%',
      }}
    >
      <CardContent sx={{ p: 3 }}>
        <Box display="flex" alignItems="flex-start" justifyContent="space-between" mb={2}>
          <Box
            sx={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              bgcolor: alpha(accentColor, 0.12),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: accentColor,
            }}
          >
            {icon}
          </Box>
        </Box>
        <Typography
          variant="caption"
          sx={{
            textTransform: 'uppercase',
            letterSpacing: 0.8,
            color: 'text.secondary',
            fontWeight: 600,
            fontSize: '0.68rem',
          }}
        >
          {label}
        </Typography>
        <Typography variant="h4" fontWeight={700} sx={{ mt: 0.5, lineHeight: 1.2 }}>
          {value}
        </Typography>
        {subLabel && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, fontSize: '0.8rem' }}>
            {subLabel}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
