import React from 'react';
import { Grid, Card, CardContent, Skeleton, Box } from '@mui/material';

export function KpiSkeleton() {
  return (
    <Grid container spacing={3}>
      {Array.from({ length: 4 }).map((_, i) => (
        <Grid size={{ xs: 12, sm: 6, lg: 3 }} key={i}>
          <Card variant="outlined" sx={{ borderRadius: 2 }}>
            <CardContent sx={{ p: 3 }}>
              <Box display="flex" mb={2}>
                <Skeleton variant="circular" width={44} height={44} />
              </Box>
              <Skeleton variant="text" width="60%" height={14} />
              <Skeleton variant="text" width="80%" height={40} sx={{ mt: 0.5 }} />
              <Skeleton variant="text" width="50%" height={14} sx={{ mt: 0.75 }} />
            </CardContent>
          </Card>
        </Grid>
      ))}
    </Grid>
  );
}
