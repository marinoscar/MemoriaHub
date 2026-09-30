/**
 * Admin → Settings → Web Push (`/admin/settings/push`). Epic #481, issue #487.
 *
 * A STANDALONE PAGE, like `EmailSettingsPage`: it has its own controller
 * (`/api/admin/push-config`) and its own document rather than a slice of the
 * generic `system_settings` blob. One card in `ADMIN_SECTIONS` gated on the
 * exact string the controller enforces (`push:read`), one route, no tab.
 * Writes need `push:write`; without it every control is disabled rather than
 * hidden, so a read-only admin can still see what is configured.
 *
 * THE PRIVATE KEY NEVER APPEARS HERE. `privateKeyStatus` carries only
 * `configured` / `last4` / `updatedAt`. The PUBLIC key is not secret — it is
 * what `pushManager.subscribe()` is given — so it renders in full with a copy
 * affordance.
 *
 * FOUR SECTIONS, IN THE ORDER AN ADMIN USES THEM:
 *
 *   1. ENABLE (configured) / GENERATE (not configured) — the everyday control.
 *   2. STATUS — read-only reference: public key, subject, key provenance.
 *   3. TEST & DIAGNOSTICS — `PushTestPanel`, only once a key pair exists.
 *   4. DANGER ZONE — rotate / remove behind `PushConfigConfirmDialog`'s two
 *      different typed literals, isolated in an error-outlined card.
 *
 * `updatedById` is a plain user id string on this API. It is rendered as
 * "by you" when it is the signed-in admin and as a short id otherwise — never
 * interpolated as an object (the reference implementation's `[object Object]`
 * bug came from exactly that).
 */

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Divider,
  FormControlLabel,
  IconButton,
  Paper,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { usePushConfig } from '../../hooks/usePushConfig';
import { useAuth } from '../../contexts/AuthContext';
import { AdminPageHeader } from '../../components/admin/AdminPageHeader';
import {
  PushConfigConfirmDialog,
  type PushConfigDialogAction,
} from '../../components/admin/PushConfigConfirmDialog';
import { PushTestPanel } from '../../components/admin/PushTestPanel';
import type { PushConfigAdminView } from '../../services/pushConfig';

const PAGE_TITLE = 'Web Push';
const PAGE_DESCRIPTION =
  'Generate the VAPID key pair, switch web push on or off, and verify delivery to your own devices.';

/** A `mailto:` or `https:` address — what the API's `vapidSubjectSchema` accepts. */
function validateSubject(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null; // Optional — the API falls back to a generic subject.
  if (!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && !/^https:\/\/\S+$/.test(trimmed)) {
    return 'Must be a mailto: address or an https: URL, e.g. mailto:admin@example.com.';
  }
  return null;
}

/** Who last changed the config, as a readable phrase. Never an object. */
function describeUpdatedBy(updatedById: string | null, currentUserId: string | null): string {
  if (!updatedById) return '';
  if (currentUserId && updatedById === currentUserId) return ' by you';
  return ` by another administrator (user ${updatedById.slice(0, 8)})`;
}

function privateKeyProvenance(status: PushConfigAdminView['privateKeyStatus']): string {
  if (!status.configured) return 'No private key is stored.';
  const which = status.last4 ? ` (ending …${status.last4})` : '';
  const when = status.updatedAt ? ` on ${new Date(status.updatedAt).toLocaleString()}` : '';
  return `Private key stored, encrypted${which}. Last set${when}.`;
}

/** A single monospace value with a copy button — the public key is not secret. */
function CopyableField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Clipboard unavailable — the value is still selectable text.
    }
  };

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {label}
        </Typography>
        <Tooltip title={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}>
          <IconButton size="small" onClick={() => void handleCopy()} aria-label={`Copy ${label}`}>
            {copied ? <CheckIcon fontSize="small" color="success" /> : <ContentCopyIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Stack>
      <Paper variant="outlined" sx={{ p: 1.5, overflowX: 'auto', backgroundColor: 'action.hover' }}>
        <Typography
          component="pre"
          sx={{ m: 0, fontFamily: 'monospace', fontSize: '0.8125rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {value}
        </Typography>
      </Paper>
    </Box>
  );
}

function StatusChip({ config }: { config: PushConfigAdminView }) {
  if (!config.configured) return <Chip label="Not configured" size="small" />;
  if (config.active) return <Chip label="Enabled" color="success" size="small" />;
  return <Chip label="Disabled" color="warning" size="small" />;
}

export default function PushConfigPage() {
  const { hasPermission } = usePermissions();
  const { user } = useAuth();
  const {
    config,
    isLoading,
    loadError,
    isSaving,
    saveError,
    save,
    clearSaveError,
    isActing,
    actionError,
    clearActionError,
    generate,
    rotate,
    remove,
  } = usePushConfig();

  const [generateSubject, setGenerateSubject] = useState('');
  const [enabledDraft, setEnabledDraft] = useState(false);
  const [subjectDraft, setSubjectDraft] = useState('');
  const [dialogAction, setDialogAction] = useState<PushConfigDialogAction | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  // The server's response is the new baseline after every load AND write —
  // including a rotate/remove, which is how the form resyncs with no reload.
  useEffect(() => {
    if (!config) return;
    if (!config.configured) {
      setGenerateSubject(config.subject ?? '');
      return;
    }
    setEnabledDraft(config.enabled);
    setSubjectDraft(config.subject ?? '');
  }, [config]);

  // Defence in depth: the card is hidden without `push:read`, but a deep link
  // still lands here. After every hook so hook order never changes.
  if (!hasPermission('push:read')) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('push:write');

  const header = (
    <AdminPageHeader
      icon={<VpnKeyOutlinedIcon color="primary" />}
      title={PAGE_TITLE}
      titleAdornment={config ? <StatusChip config={config} /> : undefined}
      description={
        <>
          {PAGE_DESCRIPTION}
          {!canWrite && ' (read-only)'}
        </>
      }
    />
  );

  if (isLoading || !config) {
    return (
      <Container maxWidth="lg">
        <Box sx={{ py: { xs: 2, sm: 4 } }}>
          {header}
          {loadError ? (
            <Alert severity="error">{loadError}</Alert>
          ) : (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
              <CircularProgress aria-label="Loading web push configuration" />
            </Box>
          )}
        </Box>
      </Container>
    );
  }

  const generateSubjectError = validateSubject(generateSubject);
  const subjectError = validateSubject(subjectDraft);
  const isFormDirty =
    enabledDraft !== config.enabled || subjectDraft.trim() !== (config.subject ?? '');

  const handleGenerate = async (event: FormEvent) => {
    event.preventDefault();
    if (generateSubjectError || !canWrite) return;
    const trimmed = generateSubject.trim();
    const ok = await generate(trimmed ? { subject: trimmed } : {});
    if (ok) setSavedMessage('Key pair generated and web push enabled');
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (subjectError || !canWrite) return;
    const trimmed = subjectDraft.trim();
    const ok = await save({ enabled: enabledDraft, subject: trimmed || null });
    if (ok) setSavedMessage('Web push configuration saved');
  };

  const handleDialogConfirm = async () => {
    if (dialogAction === 'rotate') {
      if (await rotate()) {
        setDialogAction(null);
        setSavedMessage('Key pair rotated');
      }
      return;
    }
    if (dialogAction === 'remove') {
      if (await remove()) {
        setDialogAction(null);
        setSavedMessage('Web push configuration removed');
      }
    }
  };

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        {header}

        {config.settingsError && (
          <Alert severity="warning" sx={{ mb: 3 }}>
            <AlertTitle>The stored web push configuration could not be read</AlertTitle>
            Invalid fields: {config.settingsError}
            <Box sx={{ mt: 1 }}>
              Until it is repaired, the values below are defaults rather than your saved values.
            </Box>
          </Alert>
        )}

        {/* 1. ENABLE — the everyday control. */}
        {config.configured && (
          <Paper component="section" aria-labelledby="push-enable-heading" sx={{ p: { xs: 2, sm: 3 } }}>
            <Box component="form" onSubmit={handleSave} noValidate>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2 }}>
                <NotificationsActiveOutlinedIcon color="action" />
                <Typography variant="h6" component="h2" id="push-enable-heading">
                  Enable web push
                </Typography>
              </Stack>
              <FormControlLabel
                control={
                  <Switch
                    checked={enabledDraft}
                    onChange={(e) => setEnabledDraft(e.target.checked)}
                    disabled={!canWrite}
                  />
                }
                label="Enable web push for this deployment"
              />
              {!enabledDraft && (
                <Alert severity="info" sx={{ mt: 1 }}>
                  Web push is switched off — no push notifications are sent. The key pair is kept,
                  so switching this back on needs no regenerating and existing subscriptions keep
                  working.
                </Alert>
              )}

              <Divider sx={{ my: 3 }} />

              <TextField
                fullWidth
                label="Subject (contact address)"
                placeholder="mailto:admin@example.com"
                value={subjectDraft}
                onChange={(e) => setSubjectDraft(e.target.value)}
                disabled={!canWrite}
                error={!!subjectError}
                helperText={
                  subjectError ??
                  `A mailto: address or an https: URL push services may contact if something goes wrong. Leave blank to use ${config.effectiveSubject}.`
                }
              />

              {saveError && (
                <Alert severity="error" sx={{ mt: 3 }} onClose={clearSaveError}>
                  <AlertTitle>Could not save</AlertTitle>
                  {saveError}
                </Alert>
              )}

              <Box sx={{ mt: 3 }}>
                <Button
                  type="submit"
                  variant="contained"
                  disabled={!canWrite || !isFormDirty || !!subjectError || isSaving}
                >
                  {isSaving ? 'Saving…' : 'Save changes'}
                </Button>
              </Box>
            </Box>
          </Paper>
        )}

        {/* 1'. GENERATE — first-time setup. */}
        {!config.configured && (
          <Paper component="section" aria-labelledby="push-generate-heading" sx={{ p: { xs: 2, sm: 3 } }}>
            <Box component="form" onSubmit={handleGenerate} noValidate>
              <Typography variant="h6" component="h2" id="push-generate-heading" gutterBottom>
                Generate a key pair
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Creates a new VAPID key pair and switches web push on immediately. This is a
                one-time action — once a key pair exists, use Rotate to replace it.
              </Typography>
              <TextField
                fullWidth
                label="Subject (contact address)"
                placeholder="mailto:admin@example.com"
                value={generateSubject}
                onChange={(e) => setGenerateSubject(e.target.value)}
                disabled={!canWrite || isActing}
                error={!!generateSubjectError}
                helperText={
                  generateSubjectError ??
                  'A mailto: address or an https: URL push services may contact if something goes wrong. Optional.'
                }
                sx={{ mb: 2 }}
              />
              {actionError && !dialogAction && (
                <Alert severity="error" sx={{ mb: 2 }} onClose={clearActionError}>
                  {actionError}
                </Alert>
              )}
              <Button
                type="submit"
                variant="contained"
                disabled={!canWrite || isActing || !!generateSubjectError}
              >
                {isActing ? 'Generating…' : 'Generate & enable'}
              </Button>
            </Box>
          </Paper>
        )}

        {/* 2. STATUS — read-only reference. */}
        <Paper component="section" aria-labelledby="push-status-heading" sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2 }}>
            <VpnKeyOutlinedIcon color="action" />
            <Typography variant="h6" component="h2" id="push-status-heading" sx={{ flexGrow: 1 }}>
              Status
            </Typography>
            <StatusChip config={config} />
          </Stack>

          {config.configured && config.publicKey ? (
            <Stack spacing={2}>
              <CopyableField label="Public key" value={config.publicKey} />
              <Typography variant="body2" color="text.secondary">
                Subject: {config.subject ?? `${config.effectiveSubject} (default)`}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {privateKeyProvenance(config.privateKeyStatus)}
              </Typography>
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No key pair has been generated yet. Web push is unavailable to every user until one
              is.
            </Typography>
          )}

          {config.updatedAt && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              Last updated {new Date(config.updatedAt).toLocaleString()}
              {describeUpdatedBy(config.updatedById, user?.id ?? null)}
            </Typography>
          )}
        </Paper>

        {/* 3. TEST & DIAGNOSTICS — a section of this page, not a tab. */}
        {config.configured && <PushTestPanel config={config} canWrite={canWrite} />}

        {/* 4. DANGER ZONE — destructive, last, isolated. */}
        {config.configured && (
          <Paper
            component="section"
            variant="outlined"
            aria-labelledby="push-danger-heading"
            sx={{ mt: 3, p: { xs: 2, sm: 3 }, borderColor: 'error.main' }}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
              <WarningAmberOutlinedIcon color="error" />
              <Typography variant="h6" component="h2" id="push-danger-heading" color="error">
                Danger zone
              </Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Both actions below take every existing push subscription offline. Neither can be
              undone.
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Button
                variant="outlined"
                color="error"
                disabled={!canWrite || isActing}
                onClick={() => setDialogAction('rotate')}
              >
                Rotate keys
              </Button>
              <Button
                variant="outlined"
                color="error"
                disabled={!canWrite || isActing}
                onClick={() => setDialogAction('remove')}
              >
                Remove configuration
              </Button>
            </Stack>
          </Paper>
        )}

        <PushConfigConfirmDialog
          action={dialogAction}
          isWorking={isActing}
          error={actionError}
          onConfirm={() => void handleDialogConfirm()}
          onClose={() => {
            setDialogAction(null);
            clearActionError();
          }}
        />

        <Snackbar
          open={!!savedMessage}
          autoHideDuration={3000}
          onClose={() => setSavedMessage(null)}
          message={savedMessage}
        />
      </Box>
    </Container>
  );
}
