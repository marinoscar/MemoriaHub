/**
 * The "Bulk import progress" dashboard card (RETRO-T3, #628).
 *
 * The web half of MemoriaHub's `memoriahub_import_progress` panel. The API half
 * (`apps/api/src/platform-extensions/telemetry/import-progress.dashboard-panel.ts`)
 * reads the telemetry store through the guarded facade and returns the payload
 * below; this view only draws it: one bar per enrichment stage (done vs pending
 * against the uploads of the last 24 hours), the stage's throughput and an ETA
 * (pending / processed per minute), and the oldest pending upload-time job.
 *
 * Mobile-first: a single column at every width, colours from the theme palette.
 * `main.tsx` calls `registerImportProgressPanelView()` once, before the first render.
 */
import { Box, Stack, Typography } from '@mui/material';
import { registerDashboardPanelView } from '@marinoscar/platform-web/telemetry/ui/dashboard-panels';
import type { DashboardPanelViewProps } from '@marinoscar/platform-web/telemetry/ui/dashboard-panels';

/** The panel's id: the one the API registered (the platform id pattern refuses a dot). */
export const IMPORT_PROGRESS_PANEL_ID = 'memoriahub_import_progress';

/** What the API panel returns (the API file's `ImportProgressPayload`). */
export interface ImportProgressPayload {
  available: boolean;
  uploads: number;
  windowHours: number;
  stages: Array<{ stage: string; pending: number; done: number; perMinute: number; etaMinutes: number | null }>;
  oldestPending: Array<{ jobType: string; ageSeconds: number }>;
}

const STAGE_LABELS: Record<string, string> = {
  faces: 'Faces',
  tags: 'AI tags',
  metadata: 'Metadata',
  geocode: 'Places',
  social: 'Social media check',
};

/** A duration in minutes, compactly ("45 min", "3.5 h", "2 d"). */
export function formatMinutes(minutes: number): string {
  if (minutes < 1) return 'under a minute';
  if (minutes < 90) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 6) / 10} h`;
  return `${Math.round(minutes / 144) / 10} d`;
}

function StageRow({ stage }: { stage: ImportProgressPayload['stages'][number] }) {
  const total = stage.done + stage.pending;
  const donePct = total > 0 ? (stage.done / total) * 100 : 100;
  const label = STAGE_LABELS[stage.stage] ?? stage.stage;
  const eta =
    stage.pending === 0
      ? 'Up to date'
      : stage.etaMinutes === null
        ? 'Not moving'
        : `About ${formatMinutes(stage.etaMinutes)} left`;
  return (
    <Box data-testid={`import-stage-${stage.stage}`}>
      <Stack direction="row" spacing={1} sx={{ minWidth: 0, justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
          {label}
        </Typography>
        <Typography variant="caption" color={stage.pending > 0 && stage.etaMinutes === null ? 'warning.main' : 'text.secondary'} noWrap>
          {eta}
        </Typography>
      </Stack>
      <Box
        role="img"
        aria-label={`${label}: ${stage.done.toLocaleString()} done, ${stage.pending.toLocaleString()} pending`}
        sx={{ display: 'flex', height: 10, borderRadius: 1, overflow: 'hidden', bgcolor: 'action.hover', my: 0.5 }}
      >
        <Box sx={{ width: `${donePct}%`, bgcolor: 'success.main' }} />
        <Box sx={{ flex: 1, bgcolor: stage.pending > 0 ? 'warning.light' : 'transparent' }} />
      </Box>
      <Typography variant="caption" color="text.secondary">
        {stage.done.toLocaleString()} done · {stage.pending.toLocaleString()} pending · {stage.perMinute.toLocaleString()}/min
      </Typography>
    </Box>
  );
}

export function ImportProgressPanelView({ payload }: DashboardPanelViewProps<ImportProgressPayload>) {
  if (!payload.available) {
    return (
      <Typography variant="body2" color="text.secondary" data-testid="import-progress-empty">
        No import data in the telemetry store yet.
      </Typography>
    );
  }
  const oldest = payload.oldestPending[0];
  return (
    <Stack spacing={1.5} data-testid="import-progress-view" sx={{ minWidth: 0 }}>
      <Typography variant="h5" component="p" sx={{ fontWeight: 600 }}>
        {payload.uploads.toLocaleString()}{' '}
        <Typography component="span" variant="body2" color="text.secondary">
          items uploaded in the last {payload.windowHours} h
        </Typography>
      </Typography>
      {payload.stages.map((stage) => (
        <StageRow key={stage.stage} stage={stage} />
      ))}
      {oldest ? (
        <Typography variant="caption" color="text.secondary" data-testid="import-progress-oldest">
          Oldest waiting job: {oldest.jobType.replace(/_/g, ' ')}, {formatMinutes(oldest.ageSeconds / 60)}
        </Typography>
      ) : null}
    </Stack>
  );
}

/** Registers {@link ImportProgressPanelView} for the API's panel. Call once, at boot. */
export function registerImportProgressPanelView(): void {
  registerDashboardPanelView<ImportProgressPayload>(IMPORT_PROGRESS_PANEL_ID, ImportProgressPanelView);
}
