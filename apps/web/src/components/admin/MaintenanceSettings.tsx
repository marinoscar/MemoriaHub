import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import { useMaintenance } from '../../hooks/useMaintenance';

const MESSAGE_MAX_LENGTH = 500;

interface MaintenanceSettingsProps {
  /** False when the admin holds system_settings:read but not :write. */
  disabled?: boolean;
  onSaved?: (active: boolean) => void;
}

/**
 * Admin control for maintenance mode (issue #348), rendered on the General
 * settings page at /admin/settings/general.
 *
 * Three controls, in the order they matter: the master toggle, the message
 * users see, and the `allowAdmins` bypass. The `allowAdmins` warning is not
 * boilerplate — unchecking it blocks admins too and is the one path that can
 * lock you out of this very page, recoverable only by setting
 * MAINTENANCE_MODE=false and restarting the API.
 */
export function MaintenanceSettings({ disabled, onSaved }: MaintenanceSettingsProps) {
  const { state, isLoading, isSaving, error, canWrite, save } = useMaintenance();

  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState('');
  const [allowAdmins, setAllowAdmins] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  // Re-seed the form whenever the server state changes (initial load, and
  // after each save returns the resulting state).
  useEffect(() => {
    if (!state) return;
    setEnabled(state.active);
    setMessage(state.message ?? '');
    setAllowAdmins(state.allowAdmins);
  }, [state]);

  const readOnly = disabled || !canWrite || isLoading;

  const hasChanges =
    !!state &&
    (enabled !== state.active ||
      message !== (state.message ?? '') ||
      allowAdmins !== state.allowAdmins);

  const handleSave = async () => {
    setLocalError(null);
    try {
      const next = await save({ enabled, message, allowAdmins });
      onSaved?.(next.active);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Maintenance Mode
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Takes the application offline deliberately — for a planned upgrade, or
        while a database restore swaps over. Non-exempt requests get a 503 and
        users see a maintenance screen with the message below. The flag is
        persisted, so it survives the container restart it was enabled for.
      </Typography>

      {(error || localError) && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {localError || error}
        </Alert>
      )}

      {state?.active && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>Maintenance mode is currently ON</AlertTitle>
          {state.allowAdmins
            ? 'Admins can still use the application; everyone else is blocked.'
            : 'Everyone is blocked, including admins.'}
          {state.startedAt && ` Started ${new Date(state.startedAt).toLocaleString()}.`}
        </Alert>
      )}

      {state?.envOverride !== null && state?.envOverride !== undefined && (
        <Alert severity="info" sx={{ mb: 2 }}>
          The <code>MAINTENANCE_MODE</code> environment variable is set to{' '}
          <strong>{String(state.envOverride)}</strong> and overrides whatever is
          saved here, in both directions. Changes below are still persisted, but
          take effect only once that variable is unset and the API restarts.
        </Alert>
      )}

      <FormControlLabel
        control={
          <Switch
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={readOnly}
          />
        }
        label="Enable maintenance mode"
      />

      <Box sx={{ mt: 2, maxWidth: 640 }}>
        <TextField
          label="Message shown to users"
          value={message}
          onChange={(e) => setMessage(e.target.value.slice(0, MESSAGE_MAX_LENGTH))}
          disabled={readOnly}
          fullWidth
          multiline
          minRows={2}
          placeholder="Upgrading to v2.4, back by 03:00 UTC"
          helperText={`${message.length}/${MESSAGE_MAX_LENGTH}`}
        />
      </Box>

      <Box sx={{ mt: 2 }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={allowAdmins}
              onChange={(e) => setAllowAdmins(e.target.checked)}
              disabled={readOnly}
            />
          }
          label="Allow admins to keep using the app while maintenance is on"
        />

        {!allowAdmins && (
          <Alert severity="warning" sx={{ mt: 1, maxWidth: 640 }}>
            <AlertTitle>This can lock you out of the admin UI</AlertTitle>
            With this unchecked, admins are blocked too. The only way back in is
            to set <code>MAINTENANCE_MODE=false</code> in the API environment and
            restart it. Leave it checked unless you specifically need to stop all
            traffic (e.g. a database restore cutover).
          </Alert>
        )}
      </Box>

      <Stack direction="row" spacing={2} sx={{ mt: 3, alignItems: 'center' }}>
        <Button
          variant="contained"
          color={enabled ? 'warning' : 'primary'}
          onClick={handleSave}
          disabled={readOnly || isSaving || !hasChanges}
        >
          {isSaving ? 'Saving…' : enabled ? 'Enable maintenance mode' : 'Save'}
        </Button>

        {state?.inMemoryOverride !== null && state?.inMemoryOverride !== undefined && (
          <Chip
            size="small"
            color="info"
            label={`In-memory override active: ${String(state.inMemoryOverride)}`}
          />
        )}
      </Stack>
    </Box>
  );
}
