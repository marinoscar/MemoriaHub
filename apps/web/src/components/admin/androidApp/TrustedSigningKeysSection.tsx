/**
 * Admin → Android app → Trusted signing keys (issue #516, epic #498). Ported
 * from evopath's `pages/Admin/AndroidAppPage.tsx`.
 *
 * Each trusted (package, signing SHA-256) pair becomes a Digital Asset Links
 * statement at `/.well-known/assetlinks.json`, which is what lets the app's
 * Trusted Web Activity open full screen. Every change is saved at once with
 * `PUT /api/admin/android-app` (which replaces the whole list), so "add",
 * "remove" and "Trust" all send the complete merged list.
 *
 * Validation mirrors the API (`android-app.schema.ts`): package names are
 * case-sensitive application ids; fingerprints are accepted in either case,
 * colon-separated or as 64 bare hex digits, and normalised before sending; at
 * most 10 pairs. The API still decides: a 400's `details.reason` is mapped to
 * a field error.
 */
import { useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Link,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import type { AndroidAppWriteError, WriteResult } from '../../../hooks/useAndroidApp';
import {
  ANDROID_APP_ERROR,
  MAX_TRUSTED_APPS,
  isValidFingerprint,
  isValidPackageName,
  normalizeSha256,
  type AndroidAppConfig,
  type TrustedApp,
} from '../../../services/androidApp';
import { formatRelativeTime } from '../../../utils/runFormat';
import { READ_ONLY_REASON } from './AndroidReleasesSection';

export const ASSET_LINKS_PATH = '/.well-known/assetlinks.json';
export const PACKAGE_ERROR = 'Enter an Android package name, such as memoriahub.marin.cr.';
export const SHA_ERROR =
  'Enter a SHA-256 fingerprint: 32 colon-separated hex pairs (as keytool prints it) or 64 hex digits.';
export const FULL_MESSAGE = `At most ${MAX_TRUSTED_APPS} signing keys can be trusted. Remove one first.`;

const MONO = { fontFamily: 'monospace', fontSize: '0.8rem', overflowWrap: 'anywhere' } as const;

/** Package compared exactly (case-sensitive), fingerprint normalised. */
export function sameApp(a: TrustedApp, b: TrustedApp): boolean {
  return a.packageName === b.packageName && normalizeSha256(a.sha256) === normalizeSha256(b.sha256);
}

/** Maps a failed PUT to a message, using `details.reason` when the API sent one. */
export function trustedAppsErrorMessage(error: AndroidAppWriteError): string {
  switch (error.reason) {
    case ANDROID_APP_ERROR.TOO_MANY_TRUSTED_APPS:
      return FULL_MESSAGE;
    case ANDROID_APP_ERROR.INVALID_PACKAGE_NAME:
      return PACKAGE_ERROR;
    case ANDROID_APP_ERROR.INVALID_FINGERPRINT:
      return SHA_ERROR;
    default:
      return error.message;
  }
}

interface TrustedSigningKeysSectionProps {
  canWrite: boolean;
  config: AndroidAppConfig;
  isSaving: boolean;
  save: (trustedApps: TrustedApp[]) => Promise<WriteResult<AndroidAppConfig>>;
}

interface FormErrors {
  packageName?: string;
  sha256?: string;
  form?: string;
}

export function TrustedSigningKeysSection({ canWrite, config, isSaving, save }: TrustedSigningKeysSectionProps) {
  const [packageName, setPackageName] = useState('');
  const [sha256, setSha256] = useState('');
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const trusted = config.trustedApps;
  const reported = config.reportedApps;
  const full = trusted.length >= MAX_TRUSTED_APPS;
  const writeDisabled = !canWrite || isSaving;
  const isTrusted = (app: TrustedApp) => trusted.some((t) => sameApp(t, app));

  const commit = async (next: TrustedApp[], successNotice: string): Promise<boolean> => {
    setSaveError(null);
    setNotice(null);
    const result = await save(next);
    if (result.ok) {
      setNotice(successNotice);
      return true;
    }
    const message = trustedAppsErrorMessage(result.error);
    if (result.error.reason === ANDROID_APP_ERROR.INVALID_PACKAGE_NAME) setFormErrors({ packageName: message });
    else if (result.error.reason === ANDROID_APP_ERROR.INVALID_FINGERPRINT) setFormErrors({ sha256: message });
    else setSaveError(message);
    return false;
  };

  const trust = (app: TrustedApp) => {
    if (isTrusted(app) || full) return;
    void commit([...trusted, { packageName: app.packageName, sha256: app.sha256 }], `Trusted ${app.packageName}.`);
  };

  const remove = (app: TrustedApp) => {
    void commit(
      trusted.filter((t) => !sameApp(t, app)),
      `Removed ${app.packageName}. Its app will open with an address bar until a key is trusted again.`,
    );
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = { packageName: packageName.trim(), sha256: normalizeSha256(sha256) };
    const errors: FormErrors = {};
    if (!isValidPackageName(candidate.packageName)) errors.packageName = PACKAGE_ERROR;
    if (!isValidFingerprint(candidate.sha256)) errors.sha256 = SHA_ERROR;
    if (!errors.packageName && !errors.sha256) {
      if (isTrusted(candidate)) errors.form = 'That signing key is already trusted for this package.';
      else if (full) errors.form = FULL_MESSAGE;
    }
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (await commit([...trusted, candidate], `Trusted ${candidate.packageName}.`)) {
      setPackageName('');
      setSha256('');
    }
  };

  return (
    <Paper
      variant="outlined"
      sx={{ p: 2, minWidth: 0 }}
      component="section"
      aria-labelledby="android-trusted-keys-title"
    >
      <Typography variant="h6" component="h2" id="android-trusted-keys-title" gutterBottom>
        Trusted signing keys
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        The Android app opens this site full screen only when its package and signing certificate are listed in the
        Digital Asset Links file. Without a matching key, the app shows a browser address bar. Making a release
        current trusts its signer automatically.
      </Typography>

      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {saveError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setSaveError(null)}>
          {saveError}
        </Alert>
      )}

      <Typography variant="subtitle1" component="h3" gutterBottom>
        Trusted ({trusted.length}/{MAX_TRUSTED_APPS})
      </Typography>
      {trusted.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No signing key is trusted yet. Until one is, the Android app opens this site with a browser address bar.
        </Typography>
      ) : (
        <List dense disablePadding aria-label="Trusted signing keys">
          {trusted.map((app) => (
            <ListItem
              key={`${app.packageName}|${app.sha256}`}
              divider
              disableGutters
              secondaryAction={
                <Tooltip title={canWrite ? 'Remove' : READ_ONLY_REASON}>
                  <span>
                    <IconButton
                      edge="end"
                      aria-label={`Remove ${app.packageName} ${app.sha256}`}
                      disabled={writeDisabled}
                      onClick={() => remove(app)}
                    >
                      <DeleteOutlineIcon />
                    </IconButton>
                  </span>
                </Tooltip>
              }
            >
              <ListItemText
                sx={{ pr: 6, minWidth: 0 }}
                primary={app.packageName}
                secondary={
                  <Box component="span" sx={MONO}>
                    {app.sha256}
                  </Box>
                }
              />
            </ListItem>
          ))}
        </List>
      )}

      <Box
        component="form"
        onSubmit={(e) => void onSubmit(e)}
        noValidate
        sx={{ mt: 2 }}
        aria-label="Add a trusted signing key"
      >
        <Stack spacing={1.5}>
          <TextField
            label="Package name"
            size="small"
            value={packageName}
            onChange={(e) => setPackageName(e.target.value)}
            error={Boolean(formErrors.packageName)}
            helperText={formErrors.packageName ?? 'Case-sensitive, e.g. memoriahub.marin.cr or memoriahub.marin.cr.debug.'}
            disabled={writeDisabled}
            fullWidth
          />
          <TextField
            label="Signing certificate SHA-256"
            size="small"
            value={sha256}
            onChange={(e) => setSha256(e.target.value)}
            error={Boolean(formErrors.sha256)}
            helperText={formErrors.sha256 ?? 'From keytool -list -v or apksigner verify --print-certs.'}
            disabled={writeDisabled}
            fullWidth
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
          />
          {formErrors.form && <Alert severity="warning">{formErrors.form}</Alert>}
          <Box>
            <Tooltip title={canWrite ? (full ? FULL_MESSAGE : '') : READ_ONLY_REASON}>
              <span>
                <Button type="submit" variant="contained" disabled={writeDisabled || full}>
                  Add trusted key
                </Button>
              </span>
            </Tooltip>
          </Box>
        </Stack>
      </Box>

      <Typography variant="subtitle1" component="h3" sx={{ mt: 3 }} gutterBottom>
        Reported by phones
      </Typography>
      {reported.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No paired phone has reported its app signature yet.
        </Typography>
      ) : (
        <List dense disablePadding aria-label="Reported by phones">
          {reported.map((app) => {
            const already = app.trusted || isTrusted(app);
            return (
              <ListItem
                key={`${app.packageName}|${app.sha256}`}
                divider
                disableGutters
                sx={{ display: 'block', minWidth: 0 }}
                data-testid={`reported-${app.packageName}`}
              >
                <ListItemText
                  sx={{ my: 0, minWidth: 0 }}
                  primary={app.packageName}
                  secondary={
                    <>
                      <Box component="span" sx={{ ...MONO, display: 'block' }}>
                        {app.sha256}
                      </Box>
                      {app.deviceCount === 1 ? '1 device' : `${app.deviceCount} devices`}
                      {app.lastSeenAt ? ` · last seen ${formatRelativeTime(app.lastSeenAt)}` : ''}
                    </>
                  }
                />
                <Box sx={{ mt: 0.5 }}>
                  {already ? (
                    <Chip size="small" color="success" label="Trusted" />
                  ) : (
                    <Tooltip title={canWrite ? (full ? FULL_MESSAGE : '') : READ_ONLY_REASON}>
                      <span>
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={writeDisabled || full}
                          onClick={() => trust(app)}
                          aria-label={`Trust ${app.packageName}`}
                        >
                          Trust
                        </Button>
                      </span>
                    </Tooltip>
                  )}
                </Box>
              </ListItem>
            );
          })}
        </List>
      )}

      <Box sx={{ mt: 3, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" component="h3">
          Digital Asset Links preview
        </Typography>
        <Link href={ASSET_LINKS_PATH} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
          Open {ASSET_LINKS_PATH}
          <OpenInNewIcon fontSize="inherit" />
        </Link>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Exactly what this server serves. Chrome may cache it for a few minutes.
      </Typography>
      <Box
        component="pre"
        tabIndex={0}
        aria-label="assetlinks.json preview"
        data-testid="assetlinks-preview"
        sx={{
          m: 0,
          p: 1,
          maxHeight: 320,
          overflow: 'auto',
          fontFamily: 'monospace',
          fontSize: '0.75rem',
          bgcolor: 'action.hover',
          borderRadius: 1,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {JSON.stringify(config.assetLinks, null, 2)}
      </Box>
    </Paper>
  );
}
