import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Stack,
  CircularProgress,
  Alert,
} from '@mui/material';
import EditCalendarIcon from '@mui/icons-material/EditCalendar';
import { bulkUpdateMedia } from '../../services/media';
import { ApiError } from '../../services/api';
import { civilInputToIso } from '../../utils/civilDate';

interface BulkDateDialogProps {
  open: boolean;
  onClose: () => void;
  circleId: string;
  ids: string[];
  onSuccess: (message: string) => void;
}

export function BulkDateDialog({
  open,
  onClose,
  circleId,
  ids,
  onSuccess,
}: BulkDateDialogProps) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setValue('');
      setError(null);
    }
  }, [open]);

  const handleApply = useCallback(async () => {
    if (!value) return;
    setSaving(true);
    setError(null);
    try {
      const result = await bulkUpdateMedia({
        circleId,
        ids,
        // capturedAt is a civil timestamp — the datetime-local value is a
        // wall clock and is re-encoded as UTC, not parsed in the viewer's
        // zone, which would shift every item by the browser offset (#440).
        set: { capturedAt: civilInputToIso(value) },
      });
      onSuccess(`Updated ${result.updated} item${result.updated !== 1 ? 's' : ''}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to set date taken');
      }
    } finally {
      setSaving(false);
    }
  }, [circleId, ids, value, onSuccess]);

  const handleClearDate = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await bulkUpdateMedia({
        circleId,
        ids,
        set: { capturedAt: null },
      });
      onSuccess(`Cleared date taken for ${result.updated} item${result.updated !== 1 ? 's' : ''}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to clear date taken');
      }
    } finally {
      setSaving(false);
    }
  }, [circleId, ids, onSuccess]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}>
          <EditCalendarIcon />
          <span>Set date taken for {ids.length} item{ids.length !== 1 ? 's' : ''}</span>
        </Stack>
      </DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <TextField
          label="Date taken"
          type="datetime-local"
          fullWidth
          value={value}
          onChange={(e) => setValue(e.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
          disabled={saving}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between', px: 3, pb: 2 }}>
        <Button
          variant="text"
          color="secondary"
          onClick={() => void handleClearDate()}
          disabled={saving}
        >
          Clear date
        </Button>
        <Stack direction="row" spacing={1}>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void handleApply()}
            disabled={!value || saving}
            startIcon={saving ? <CircularProgress size={14} /> : undefined}
          >
            Apply
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
