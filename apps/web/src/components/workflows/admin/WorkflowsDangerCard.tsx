import {
  Card,
  CardContent,
  Box,
  Typography,
  Switch,
  FormControlLabel,
  Alert,
} from '@mui/material';
import { WarningAmber as WarningAmberIcon } from '@mui/icons-material';

// ---------------------------------------------------------------------------
// Workflows danger card (issue #143).
//
// The `workflows.allowHardDelete` unlock, visually separated in an
// error-outlined Card. Purely presentational and props-driven for testability:
// the parent owns the setting value and the save handler.
// ---------------------------------------------------------------------------

interface WorkflowsDangerCardProps {
  /** Current value of `workflows.allowHardDelete`. */
  allowHardDelete: boolean;
  /** True while a save is in flight (disables the toggle). */
  saving: boolean;
  /** True once settings have loaded (toggle stays disabled until then). */
  ready: boolean;
  /** Called with the new value when the admin flips the switch. */
  onToggle: (next: boolean) => void;
}

export function WorkflowsDangerCard({
  allowHardDelete,
  saving,
  ready,
  onToggle,
}: WorkflowsDangerCardProps) {
  return (
    <Card
      variant="outlined"
      sx={{
        borderColor: 'error.main',
        borderWidth: 2,
        borderRadius: 2,
      }}
    >
      <CardContent sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <WarningAmberIcon color="error" />
          <Typography variant="h6" sx={{ fontWeight: 700, color: 'error.main' }}>
            Danger Zone
          </Typography>
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Permanently deleting media is <strong>unrecoverable</strong> — hard-deleted
          items skip the Trash and their storage blobs are erased with no way to
          restore them.
        </Typography>

        <FormControlLabel
          control={
            <Switch
              color="error"
              checked={allowHardDelete}
              onChange={(e) => onToggle(e.target.checked)}
              disabled={saving || !ready}
              slotProps={{ input: { 'aria-label': 'Allow the hard-delete workflow action' } }}
            />
          }
          label="Allow the hard-delete workflow action app-wide"
          sx={{ display: 'block', mb: 1 }}
        />

        <Typography variant="body2" color="text.secondary">
          Even when enabled, a hard-delete workflow can only run on a manual trigger,
          requires the <code>media:delete</code> permission, and demands a typed
          confirmation before it executes. Leave this off unless you specifically
          need permanent deletion.
        </Typography>

        {allowHardDelete && (
          <Alert severity="error" sx={{ mt: 2 }}>
            Hard delete is currently <strong>unlocked</strong>. Workflows may permanently
            erase media that matches their conditions.
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
