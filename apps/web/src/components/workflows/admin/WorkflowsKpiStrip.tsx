import { Grid, useTheme } from '@mui/material';
import {
  PlayCircleOutlined,
  DoneAll,
  ErrorOutlined,
  Bolt,
} from '@mui/icons-material';
import { KpiCard } from '../../insights/KpiCard';
import { KpiSkeleton } from '../../insights/KpiSkeleton';
import type { AdminWorkflowStats } from '../../../services/adminWorkflows';

// ---------------------------------------------------------------------------
// Workflows KPI strip (issue #143).
//
// Reuses the job-insights KpiCard visual style. Props-driven for testability:
// the parent owns fetching and passes `stats` (or null while loading).
// ---------------------------------------------------------------------------

interface WorkflowsKpiStripProps {
  stats: AdminWorkflowStats | null;
  loading: boolean;
}

export function WorkflowsKpiStrip({ stats, loading }: WorkflowsKpiStripProps) {
  const theme = useTheme();

  if (loading && !stats) {
    return <KpiSkeleton />;
  }

  if (!stats) return null;

  return (
    <Grid container spacing={3}>
      <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
        <KpiCard
          label={`Runs (last ${stats.windowDays}d)`}
          value={stats.runsLast7Days.toLocaleString()}
          icon={<PlayCircleOutlined />}
          accentColor="#3b82f6"
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
        <KpiCard
          label="Items actioned"
          value={stats.itemsActioned.toLocaleString()}
          subLabel={`in the last ${stats.windowDays} days`}
          icon={<DoneAll />}
          accentColor="#10b981"
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
        <KpiCard
          label="Failures"
          value={stats.failures.toLocaleString()}
          subLabel={`in the last ${stats.windowDays} days`}
          icon={<ErrorOutlined />}
          accentColor={theme.palette.error.main}
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
        <KpiCard
          label="Currently running"
          value={stats.currentlyRunning.toLocaleString()}
          icon={<Bolt />}
          accentColor="#8b5cf6"
        />
      </Grid>
    </Grid>
  );
}
