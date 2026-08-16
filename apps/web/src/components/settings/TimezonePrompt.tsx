import { useState } from 'react';
import { Alert, Button, Snackbar } from '@mui/material';
import { useAuth } from '../../contexts/AuthContext';

/**
 * "Looks like you're in a different time zone — switch?" (issue #444).
 *
 * Purely presentational: detection, the once-per-session guard and the
 * dismissal record all live in `useTimezoneAutoDetect`, driven from
 * `AuthProvider`. This component exists only because that provider sits above
 * MUI's `ThemeProvider` in the tree and so cannot render themed chrome itself.
 *
 * A mismatch is deliberately never auto-applied — a user who set their home
 * zone on purpose must not have it rewritten by an airport browser — so the
 * only two outcomes here are an explicit Update and a dismissal that holds for
 * the rest of the session.
 */
export function TimezonePrompt() {
  const { timezoneMismatch, applyDetectedTimezone, dismissTimezoneMismatch } =
    useAuth();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!timezoneMismatch) return null;

  const handleUpdate = async () => {
    setSaving(true);
    setFailed(false);
    try {
      await applyDetectedTimezone();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Snackbar
      open
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      onClose={(_event, reason) => {
        // Don't let a stray click elsewhere count as a decision.
        if (reason === 'clickaway') return;
        dismissTimezoneMismatch();
      }}
    >
      <Alert
        severity={failed ? 'error' : 'info'}
        onClose={dismissTimezoneMismatch}
        action={
          <Button color="inherit" size="small" disabled={saving} onClick={handleUpdate}>
            {saving ? 'Updating…' : 'Update'}
          </Button>
        }
      >
        {failed
          ? "Couldn't update your time zone. Try again from Settings."
          : `Your device is in ${timezoneMismatch.detected}, but your time zone is set to ${timezoneMismatch.stored}.`}
      </Alert>
    </Snackbar>
  );
}
