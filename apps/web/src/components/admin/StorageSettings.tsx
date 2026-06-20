import {
  Box,
  Typography,
  TextField,
  Button,
} from '@mui/material';
import { useState, useEffect } from 'react';

const DEFAULT_REFRESH_HOURS = 4;
const MIN_REFRESH_HOURS = 1;
const MAX_REFRESH_HOURS = 168; // 1 week

interface StorageInsightsConfig {
  refreshIntervalHours?: number;
}

interface StorageConfig {
  insights?: StorageInsightsConfig;
}

interface StorageSettingsProps {
  settings: StorageConfig | undefined;
  onSave: (storage: StorageConfig) => Promise<void>;
  disabled?: boolean;
}

export function StorageSettings({ settings, onSave, disabled }: StorageSettingsProps) {
  const initialHours = settings?.insights?.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS;

  const [refreshHours, setRefreshHours] = useState<number>(initialHours);
  const [inputError, setInputError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setRefreshHours(settings?.insights?.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS);
  }, [settings]);

  const hasChanges = refreshHours !== (settings?.insights?.refreshIntervalHours ?? DEFAULT_REFRESH_HOURS);

  const handleChange = (raw: string) => {
    const val = parseInt(raw, 10);
    setRefreshHours(isNaN(val) ? 0 : val);
    if (isNaN(val) || val < MIN_REFRESH_HOURS || val > MAX_REFRESH_HOURS) {
      setInputError(`Must be between ${MIN_REFRESH_HOURS} and ${MAX_REFRESH_HOURS}`);
    } else {
      setInputError(null);
    }
  };

  const handleSave = async () => {
    if (inputError || !hasChanges) return;
    setIsSaving(true);
    try {
      await onSave({ insights: { refreshIntervalHours: refreshHours } });
    } finally {
      setIsSaving(false);
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
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled}
        error={!!inputError}
        helperText={inputError ?? `How often storage metrics are recomputed. Default: ${DEFAULT_REFRESH_HOURS} hours.`}
        slotProps={{ htmlInput: { min: MIN_REFRESH_HOURS, max: MAX_REFRESH_HOURS, step: 1 } }}
        sx={{ width: 320 }}
      />

      <Box sx={{ mt: 3 }}>
        <Button
          variant="contained"
          onClick={() => void handleSave()}
          disabled={disabled || !hasChanges || isSaving || !!inputError}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </Box>
    </Box>
  );
}
