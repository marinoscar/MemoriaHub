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
  /** Clears the lifetime job-stats rollup (all-time analytics). */
  onResetHistory?: () => Promise<void>;
  disabled?: boolean;
}

export function StorageSettings({ settings, jobsSettings, onSave, onSaveJobs, onResetHistory, disabled }: StorageSettingsProps) {
  const initialHours = settings?.insights?.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS;

  const [refreshHours, setRefreshHours] = useState<number>(initialHours);
  const [refreshError, setRefreshError] = useState<string | null>(null);

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
  const [isResetting, setIsResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  useEffect(() => {
    setRefreshHours(settings?.insights?.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS);
  }, [settings]);

  useEffect(() => {
    setJobRetentionDays(jobsSettings?.history?.retentionDays ?? DEFAULT_JOB_RETENTION_DAYS);
    setJobPurgeEnabled(jobsSettings?.history?.purgeEnabled ?? true);
  }, [jobsSettings]);

  const hasChanges =
    refreshHours !== (settings?.insights?.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS);
  const hasErrors = !!refreshError;

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

  const handleResetHistory = async () => {
    if (!onResetHistory || isResetting) return;
    const ok = window.confirm(
      'Reset lifetime job analytics? This clears all-time totals (counts and average durations). Live job records are not affected. This cannot be undone.',
    );
    if (!ok) return;
    setIsResetting(true);
    setResetMessage(null);
    try {
      await onResetHistory();
      setResetMessage('Lifetime job analytics reset.');
    } finally {
      setIsResetting(false);
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

          <Box sx={{ mt: 3, display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button
              variant="contained"
              onClick={() => void handleSaveJobs()}
              disabled={disabled || !hasJobChanges || isSavingJobs || !!jobRetentionError}
            >
              {isSavingJobs ? 'Saving...' : 'Save Job Settings'}
            </Button>

            {onResetHistory && (
              <Button
                variant="outlined"
                color="error"
                onClick={() => void handleResetHistory()}
                disabled={disabled || isResetting}
              >
                {isResetting ? 'Resetting...' : 'Reset lifetime history'}
              </Button>
            )}
            {resetMessage && (
              <Typography variant="caption" color="success.main">
                {resetMessage}
              </Typography>
            )}
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Reset clears all-time analytics totals (counts and average durations). Live job records
            are not affected.
          </Typography>
        </>
      )}
    </Box>
  );
}
