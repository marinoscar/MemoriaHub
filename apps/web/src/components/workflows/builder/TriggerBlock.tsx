import {
  TextField,
  RadioGroup,
  FormControlLabel,
  Radio,
  Switch,
  Box,
  Stack,
  Typography,
  Button,
  Alert,
} from '@mui/material';
import { BuilderBlock } from './BuilderBlock';
import type {
  WorkflowTriggerType,
  SubjectRegistryEntry,
} from '../../../types/workflows';
import { cronToText } from '../../../utils/workflowFormat';
import {
  CRON_PRESETS,
  CRON_MIN_INTERVAL_HINT,
  isValidCron,
} from '../../../utils/workflowCron';

interface TriggerBlockProps {
  subject: SubjectRegistryEntry | undefined;
  name: string;
  description: string;
  enabled: boolean;
  trigger: WorkflowTriggerType;
  cronExpression: string;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  onEnabled: (v: boolean) => void;
  onTrigger: (v: WorkflowTriggerType) => void;
  onCron: (v: string) => void;
  /** True when a gated action (hard_delete) is present but the trigger is non-manual. */
  gatedActionError?: string | null;
  /** Minimum-interval note from settings, if available (else the static hint is shown). */
  minIntervalNote?: string | null;
  nameError?: boolean;
}

const TRIGGER_LABELS: Record<WorkflowTriggerType, string> = {
  manual: 'Manual — I run it myself',
  on_media_enriched: 'When new media is enriched',
  scheduled: 'On a schedule',
};

// ---------------------------------------------------------------------------
// TriggerBlock — name / description / enabled + the trigger radio and, for the
// scheduled option, a cron helper (presets + validated raw field).
// ---------------------------------------------------------------------------

export function TriggerBlock({
  subject,
  name,
  description,
  enabled,
  trigger,
  cronExpression,
  onName,
  onDescription,
  onEnabled,
  onTrigger,
  onCron,
  gatedActionError,
  minIntervalNote,
  nameError,
}: TriggerBlockProps) {
  // v1 registers the same trigger vocabulary for every Subject; fall back to the
  // full set if the registry entry has not loaded yet.
  const triggers: WorkflowTriggerType[] =
    subject?.triggers ?? ['manual', 'on_media_enriched', 'scheduled'];

  const cronInvalid = trigger === 'scheduled' && cronExpression.trim() !== '' && !isValidCron(cronExpression);

  return (
    <BuilderBlock
      keyword="WHEN"
      title="Trigger"
      subtitle="Name your workflow and choose how a run starts."
      color="secondary"
      action={
        <FormControlLabel
          control={
            <Switch checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />
          }
          label={enabled ? 'Enabled' : 'Disabled'}
          labelPlacement="start"
        />
      }
    >
      <Stack spacing={2.5}>
        <TextField
          label="Name"
          required
          fullWidth
          size="small"
          value={name}
          onChange={(e) => onName(e.target.value)}
          error={nameError}
          helperText={nameError ? 'A name is required' : undefined}
        />
        <TextField
          label="Description"
          fullWidth
          size="small"
          multiline
          maxRows={3}
          value={description}
          onChange={(e) => onDescription(e.target.value)}
        />

        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
            Run this workflow…
          </Typography>
          <RadioGroup
            value={trigger}
            onChange={(e) => onTrigger(e.target.value as WorkflowTriggerType)}
          >
            {triggers.map((t) => (
              <FormControlLabel
                key={t}
                value={t}
                control={<Radio size="small" />}
                label={TRIGGER_LABELS[t]}
              />
            ))}
          </RadioGroup>
        </Box>

        {gatedActionError && (
          <Alert severity="error">{gatedActionError}</Alert>
        )}

        {trigger === 'scheduled' && (
          <Box
            sx={{
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              p: 2,
            }}
          >
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
              Schedule
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
              {CRON_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  size="small"
                  variant={cronExpression === preset.expression ? 'contained' : 'outlined'}
                  onClick={() => onCron(preset.expression)}
                >
                  {preset.label}
                </Button>
              ))}
            </Stack>
            <TextField
              label="Cron expression (min hour day month weekday)"
              fullWidth
              size="small"
              value={cronExpression}
              onChange={(e) => onCron(e.target.value)}
              error={cronInvalid}
              helperText={
                cronInvalid
                  ? 'Not a valid hourly-or-slower 5-field cron expression'
                  : cronExpression.trim()
                    ? cronToText(cronExpression)
                    : 'e.g. 0 3 * * * (nightly at 3 AM)'
              }
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              {minIntervalNote || CRON_MIN_INTERVAL_HINT}
            </Typography>
          </Box>
        )}
      </Stack>
    </BuilderBlock>
  );
}
