import {
  Box,
  Typography,
  TextField,
  Button,
  Divider,
  FormControlLabel,
  Switch,
} from '@mui/material';
import { useState, useEffect } from 'react';

const DEFAULT_REFRESH_HOURS = 4;
const MIN_REFRESH_HOURS = 1;
const MAX_REFRESH_HOURS = 168; // 1 week

const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;

const DEFAULT_JOB_RETENTION_DAYS = 30;
const MIN_JOB_RETENTION_DAYS = 1;
const MAX_JOB_RETENTION_DAYS = 365;

interface StorageInsightsConfig {
  refreshIntervalHours?: number;
}

interface StorageTrashConfig {
  retentionDays?: number;
}

interface StorageConfig {
  insights?: StorageInsightsConfig;
  trash?: StorageTrashConfig;
}

interface JobsHistoryConfig {
  retentionDays?: number;
  purgeEnabled?: boolean;
}

interface JobsConfig {
  history?: JobsHistoryConfig;
}

interface StorageSettingsProps {
  settings: StorageConfig | undefined;
  jobsSettings?: JobsConfig;
  onSave: (storage: StorageConfig) => Promise<void>;
  onSaveJobs?: (jobs: JobsConfig) => Promise<void>;
  disabled?: boolean;
}

export function StorageSettings({ settings, jobsSettings, onSave, onSaveJobs, disabled }: StorageSettingsProps) {
  const initialHours = settings?.insights?.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS;
  const initialRetentionDays = settings?.trash?.retentionDays ?? DEFAULT_RETENTION_DAYS;

  const [refreshHours, setRefreshHours] = useState<number>(initialHours);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const [retentionDays, setRetentionDays] = useState<number>(initialRetentionDays);
  const [retentionError, setRetentionError] = useState<string | null>(null);

  const [isSaving, setIsSaving] = useState(false);

  // Job history state
  const [jobRetentionDays, setJobRetentionDays] = useState<number>(
    jobsSettings?.history?.retentionDays ?? DEFAULT_JOB_RETENTION_DAYS,
  );
  const [jobRetentionError, setJobRetentionError] = useState<string | null>(null);
  const [jobPurgeEnabled, setJobPurgeEnabled] = useState<boolean>(
    jobsSettings?.history?.purgeEnabled ?? true,
  );
  const [isSavingJobs, setIsSavingJobs] = useState(false);

  useEffect(() => {
    setRefreshHours(settings?.insights?.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS);
    setRetentionDays(settings?.trash?.retentionDays ?? DEFAULT_RETENTION_DAYS);
  }, [settings]);

  useEffect(() => {
    setJobRetentionDays(jobsSettings?.history?.retentionDays ?? DEFAULT_JOB_RETENTION_DAYS);
    setJobPurgeEnabled(jobsSettings?.history?.purgeEnabled ?? true);
  }, [jobsSettings]);

  const hasInsightsChanges =
    refreshHours !== (settings?.insights?.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS);
  const hasTrashChanges =
    retentionDays !== (settings?.trash?.retentionDays ?? DEFAULT_RETENTION_DAYS);
  const hasChanges = hasInsightsChanges || hasTrashChanges;
  const hasErrors = !!refreshError || !!retentionError;

  const hasJobRetentionChanges =
    jobRetentionDays !== (jobsSettings?.history?.retentionDays ?? DEFAULT_JOB_RETENTION_DAYS);
  const hasJobPurgeChanges =
    jobPurgeEnabled !== (jobsSettings?.history?.purgeEnabled ?? true);
  const hasJobChanges = hasJobRetentionChanges || hasJobPurgeChanges;

  const handleRefreshChange = (raw: string) => {
    const val = parseInt(raw, 10);
    setRefreshHours(isNaN(val) ? 0 : val);
    if (isNaN(val) || val < MIN_REFRESH_HOURS || val > MAX_REFRESH_HOURS) {
      setRefreshError(`Must be between ${MIN_REFRESH_HOURS} and ${MAX_REFRESH_HOURS}`);
    } else {
      setRefreshError(null);
    }
  };

  const handleRetentionChange = (raw: string) => {
    const val = parseInt(raw, 10);
    setRetentionDays(isNaN(val) ? 0 : val);
    if (isNaN(val) || val < MIN_RETENTION_DAYS || val > MAX_RETENTION_DAYS) {
      setRetentionError(`Must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`);
    } else {
      setRetentionError(null);
    }
  };

  const handleJobRetentionChange = (raw: string) => {
    const val = parseInt(raw, 10);
    setJobRetentionDays(isNaN(val) ? 0 : val);
    if (isNaN(val) || val < MIN_JOB_RETENTION_DAYS || val > MAX_JOB_RETENTION_DAYS) {
      setJobRetentionError(`Must be between ${MIN_JOB_RETENTION_DAYS} and ${MAX_JOB_RETENTION_DAYS}`);
    } else {
      setJobRetentionError(null);
    }
  };

  const handleSave = async () => {
    if (hasErrors || !hasChanges) return;
    setIsSaving(true);
    try {
      await onSave({
        insights: { refreshIntervalHours: refreshHours },
        trash: { retentionDays },
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveJobs = async () => {
    if (jobRetentionError || !hasJobChanges || !onSaveJobs) return;
    setIsSavingJobs(true);
    try {
      await onSaveJobs({
        history: {
          retentionDays: jobRetentionDays,
          purgeEnabled: jobPurgeEnabled,
        },
      });
    } finally {
      setIsSavingJobs(false);
    }
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Storage
      </Typography>

      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
        Insights
      </Typography>

      <TextField
        label="Insights refresh interval (hours)"
        type="number"
        value={refreshHours}
        onChange={(e) => handleRefreshChange(e.target.value)}
        disabled={disabled}
        error={!!refreshError}
        helperText={refreshError ?? `How often storage metrics are recomputed. Default: ${DEFAULT_REFRESH_HOURS} hours.`}
        slotProps={{ htmlInput: { min: MIN_REFRESH_HOURS, max: MAX_REFRESH_HOURS, step: 1 } }}
        sx={{ width: 320 }}
      />

      <Box sx={{ mt: 3, mb: 1 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
          Trash
        </Typography>

        <TextField
          label="Trash retention period (days)"
          type="number"
          value={retentionDays}
          onChange={(e) => handleRetentionChange(e.target.value)}
          disabled={disabled}
          error={!!retentionError}
          helperText={
            retentionError ??
            `How long deleted items are kept in Trash before permanent deletion. Default: ${DEFAULT_RETENTION_DAYS} days.`
          }
          slotProps={{ htmlInput: { min: MIN_RETENTION_DAYS, max: MAX_RETENTION_DAYS, step: 1 } }}
          sx={{ width: 320 }}
        />
      </Box>

      <Box sx={{ mt: 3 }}>
        <Button
          variant="contained"
          onClick={() => void handleSave()}
          disabled={disabled || !hasChanges || isSaving || hasErrors}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </Box>

      {/* Job History section — only rendered when the callback is provided */}
      {onSaveJobs && (
        <>
          <Divider sx={{ my: 4 }} />

          <Typography variant="h6" gutterBottom>
            Job History
          </Typography>

          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
            Retention
          </Typography>

          <TextField
            label="Job history retention (days)"
            type="number"
            value={jobRetentionDays}
            onChange={(e) => handleJobRetentionChange(e.target.value)}
            disabled={disabled}
            error={!!jobRetentionError}
            helperText={
              jobRetentionError ??
              `How long completed job records are kept before automatic deletion. Default: ${DEFAULT_JOB_RETENTION_DAYS} days.`
            }
            slotProps={{ htmlInput: { min: MIN_JOB_RETENTION_DAYS, max: MAX_JOB_RETENTION_DAYS, step: 1 } }}
            sx={{ width: 320 }}
          />

          <Box sx={{ mt: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={jobPurgeEnabled}
                  onChange={(e) => setJobPurgeEnabled(e.target.checked)}
                  disabled={disabled}
                />
              }
              label="Auto-purge old job records"
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              When enabled, job records older than the retention period are automatically deleted.
            </Typography>
          </Box>

          <Box sx={{ mt: 3 }}>
            <Button
              variant="contained"
              onClick={() => void handleSaveJobs()}
              disabled={disabled || !hasJobChanges || isSavingJobs || !!jobRetentionError}
            >
              {isSavingJobs ? 'Saving...' : 'Save Job Settings'}
            </Button>
          </Box>
        </>
      )}
    </Box>
  );
}
