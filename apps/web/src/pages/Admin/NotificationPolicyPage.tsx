/**
 * Admin → Settings → Notifications (`/admin/settings/notifications`).
 * Epic #481, issue #487.
 *
 * The deployment-wide notification POLICY: the three kill switches the API's
 * `NotificationPolicyService` reads out of `system_settings.notifications`:
 *
 *   browserEnabled — withholds the in-page browser toast; inbox rows unaffected.
 *   pushEnabled    — stops every Web Push, mandatory types included.
 *   disabledTypes  — per type: stops new inbox rows AND push for that type.
 *                    A mandatory type keeps its inbox row (never its push).
 *
 * Its own destination (one card in `ADMIN_SECTIONS`, gated on
 * `system_settings:read`), not a tab on the System page. Writes are gated on
 * `system_settings:write` inside the page (disabled controls). It PATCHes only
 * those three keys of the `notifications` namespace: the API merges that
 * namespace field by field, so the retention knobs `StorageSettings` edits
 * (`retentionDays`, `purgeEnabled`) are never touched from here.
 *
 * WHY THE SWITCH IS INVERTED RELATIVE TO THE STORED FIELD. The document stores
 * `disabledTypes` (a suppression list) while each row renders a switch that is
 * ON when the type is delivered — matching the per-user preferences on
 * `/settings`, where on means "you receive this". The inversion happens in one
 * place (`toggleType`), never in render.
 *
 * EVERY SUPPRESSED TYPE STAYS LISTED. The rows are the closed catalog PLUS any
 * stored `disabledTypes` entry the catalog does not know, so a suppression can
 * never become invisible — and therefore un-liftable — from the one page that
 * can lift it (the reference implementation's #521 bug was exactly that).
 *
 * A BATCHED SAVE: `disabledTypes` is one array the API replaces wholesale, so
 * a per-click PATCH would race with itself. The local mirror is the pending
 * value; the stored document re-seeds it after every save or refetch.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, Navigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Divider,
  FormControlLabel,
  Link,
  Paper,
  Snackbar,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import NotificationsOutlinedIcon from '@mui/icons-material/NotificationsOutlined';
import LockIcon from '@mui/icons-material/Lock';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { AdminPageHeader } from '../../components/admin/AdminPageHeader';
import {
  NOTIFICATION_TYPE_CATALOG,
  notificationTypeInfo,
  type NotificationTypeInfo,
} from '../../components/admin/notificationTypeCatalog';
import type { SystemSettings } from '../../types';

const PAGE_TITLE = 'Notifications';
const PAGE_DESCRIPTION =
  'Turn in-app browser notifications and web push on or off for everyone, and switch off individual notification types.';

/** The slice of `system_settings.notifications` this page owns. */
export interface NotificationPolicySettings {
  browserEnabled: boolean;
  pushEnabled: boolean;
  disabledTypes: string[];
}

/** The API's documented defaults — used when an older API returns no policy keys. */
const DEFAULT_POLICY: NotificationPolicySettings = {
  browserEnabled: true,
  pushEnabled: true,
  disabledTypes: [],
};

function readPolicy(settings: SystemSettings | null): NotificationPolicySettings {
  const stored = (settings?.notifications ?? {}) as Partial<NotificationPolicySettings>;
  return {
    browserEnabled: stored.browserEnabled ?? DEFAULT_POLICY.browserEnabled,
    pushEnabled: stored.pushEnabled ?? DEFAULT_POLICY.pushEnabled,
    disabledTypes: Array.isArray(stored.disabledTypes) ? stored.disabledTypes : [],
  };
}

/** Order-insensitive set comparison, so re-ordering alone is not "dirty". */
function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((key, index) => key === right[index]);
}

interface TypeRowProps {
  info: NotificationTypeInfo;
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}

function TypeRow({ info, enabled, disabled, onChange }: TypeRowProps) {
  return (
    <Box sx={{ py: 1.5, display: 'flex', alignItems: 'flex-start', gap: 2 }}>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
          <Typography variant="subtitle2">{info.label}</Typography>
          {info.mandatory && (
            <Chip size="small" icon={<LockIcon />} label="Inbox always delivered" variant="outlined" />
          )}
          {!enabled && <Chip size="small" label="Off for everyone" color="warning" />}
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {info.description}
        </Typography>
        <Typography variant="caption" color="text.disabled" sx={{ wordBreak: 'break-word' }}>
          {info.type}
        </Typography>
      </Box>
      <Switch
        checked={enabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        slotProps={{ input: { 'aria-label': `Deliver ${info.label} notifications` } }}
      />
    </Box>
  );
}

function NotificationPolicyContent() {
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('system_settings:write');
  const { settings, isLoading, error, isSaving, updateSettings } = useSystemSettings();

  const stored = useMemo(() => readPolicy(settings), [settings]);
  const [browserEnabled, setBrowserEnabled] = useState(stored.browserEnabled);
  const [pushEnabled, setPushEnabled] = useState(stored.pushEnabled);
  const [disabledTypes, setDisabledTypes] = useState<string[]>(stored.disabledTypes);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  useEffect(() => {
    setBrowserEnabled(stored.browserEnabled);
    setPushEnabled(stored.pushEnabled);
    setDisabledTypes(stored.disabledTypes);
  }, [stored]);

  // The closed catalog plus any stored suppression it does not recognise.
  const rows = useMemo(() => {
    const known = new Set(NOTIFICATION_TYPE_CATALOG.map((info) => info.type));
    const extra = [...new Set([...stored.disabledTypes, ...disabledTypes])]
      .filter((type) => !known.has(type))
      .map(notificationTypeInfo);
    return [...NOTIFICATION_TYPE_CATALOG, ...extra];
  }, [stored.disabledTypes, disabledTypes]);

  if (isLoading && !settings) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress aria-label="Loading notification settings" />
      </Box>
    );
  }

  if (error && !settings) {
    return <Alert severity="error">{error}</Alert>;
  }

  const isDirty =
    browserEnabled !== stored.browserEnabled ||
    pushEnabled !== stored.pushEnabled ||
    !sameKeys(disabledTypes, stored.disabledTypes);
  const controlsDisabled = !canWrite || isSaving;

  const toggleType = (type: string, enabled: boolean) => {
    setDisabledTypes((current) =>
      enabled ? current.filter((t) => t !== type) : [...new Set([...current, type])],
    );
  };

  const handleSave = async () => {
    setSaveError(null);
    try {
      await updateSettings({
        notifications: { browserEnabled, pushEnabled, disabledTypes },
      } as Partial<SystemSettings>);
      setSavedMessage('Notification settings saved');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save notification settings');
    }
  };

  const handleReset = () => {
    setBrowserEnabled(stored.browserEnabled);
    setPushEnabled(stored.pushEnabled);
    setDisabledTypes(stored.disabledTypes);
  };

  return (
    <>
      <Paper component="section" aria-labelledby="notif-channels-heading" sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography variant="h6" component="h2" id="notif-channels-heading" gutterBottom>
          Delivery channels
        </Typography>

        <FormControlLabel
          control={
            <Switch
              checked={browserEnabled}
              disabled={controlsDisabled}
              onChange={(e) => setBrowserEnabled(e.target.checked)}
            />
          }
          label="Show browser notifications while the app is open"
        />
        <Typography variant="body2" color="text.secondary" sx={{ ml: { xs: 0, sm: 6 }, mb: 2 }}>
          When off, nobody sees a pop-up toast for a new notification in an open tab. Notifications
          still arrive in everyone&apos;s inbox, and web push is unaffected.
        </Typography>

        <FormControlLabel
          control={
            <Switch
              checked={pushEnabled}
              disabled={controlsDisabled}
              onChange={(e) => setPushEnabled(e.target.checked)}
            />
          }
          label="Send web push notifications"
        />
        <Typography variant="body2" color="text.secondary" sx={{ ml: { xs: 0, sm: 6 } }}>
          When off, no push notification is sent to any device, for any type, and browsers are no
          longer offered push. The VAPID key pair on the{' '}
          <Link component={RouterLink} to="/admin/settings/push">
            Web Push
          </Link>{' '}
          page is kept, so switching this back on needs no reconfiguration.
        </Typography>
      </Paper>

      <Paper component="section" aria-labelledby="notif-types-heading" sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
        <Typography variant="h6" component="h2" id="notif-types-heading" gutterBottom>
          Notification types
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Switch a type off to stop it for everyone. Turning a type off stops new inbox
          notifications <strong>and</strong> web push for it; notifications already delivered are
          left in place. Types marked &ldquo;Inbox always delivered&rdquo; are mandatory: they
          keep arriving in the inbox, and only their push is stopped. Users can still switch
          types off for themselves on their own Settings page, but cannot switch back on a type
          that is off here.
        </Typography>

        {!pushEnabled && (
          <Alert severity="info" sx={{ my: 2 }}>
            Web push is off for everyone, so these switches currently control inbox delivery only.
          </Alert>
        )}

        <Stack divider={<Divider flexItem />} sx={{ mt: 1 }} aria-label="Notification type switches">
          {rows.map((info) => (
            <TypeRow
              key={info.type}
              info={info}
              enabled={!disabledTypes.includes(info.type)}
              disabled={controlsDisabled}
              onChange={(enabled) => toggleType(info.type, enabled)}
            />
          ))}
        </Stack>
      </Paper>

      {saveError && (
        <Alert severity="error" sx={{ mt: 3 }} onClose={() => setSaveError(null)}>
          {saveError}
        </Alert>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 3 }}>
        <Button variant="contained" onClick={() => void handleSave()} disabled={controlsDisabled || !isDirty}>
          {isSaving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button onClick={handleReset} disabled={controlsDisabled || !isDirty}>
          Discard changes
        </Button>
      </Stack>
      {!canWrite && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          You can view these settings but not change them (requires system_settings:write).
        </Typography>
      )}

      <Snackbar
        open={!!savedMessage}
        autoHideDuration={3000}
        onClose={() => setSavedMessage(null)}
        message={savedMessage}
      />
    </>
  );
}

export default function NotificationPolicyPage() {
  const { hasPermission } = usePermissions();

  if (!hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        <AdminPageHeader
          icon={<NotificationsOutlinedIcon color="primary" />}
          title={PAGE_TITLE}
          description={PAGE_DESCRIPTION}
        />
        <NotificationPolicyContent />
      </Box>
    </Container>
  );
}
