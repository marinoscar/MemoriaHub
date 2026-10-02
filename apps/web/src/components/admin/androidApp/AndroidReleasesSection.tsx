/**
 * Admin → Android app → Releases (issue #516, epic #498). Ported from
 * evopath's `components/admin/androidApp/AndroidReleasesSection.tsx`.
 *
 * The APKs this deployment hosts: the current release, an upload form (an
 * `.apk`, optionally with the sidecar `.json` `memoriahub android build`
 * writes next to it, which fills the fields in), and every release with
 * **Make current** (a rollback to a lower version code asks first) and
 * **Delete** (never the current one, and always confirmed).
 *
 * The API decides everything that matters — uniqueness, "newer than current",
 * the ZIP magic, the checksum, trusting the signer when a release becomes
 * current. The form only checks shapes so a typo fails before a 150 MB upload.
 * Every write control is disabled without `system_settings:write` (`canWrite`).
 *
 * No "N devices behind" count (spec §22 D19): no admin device aggregate
 * exists in v1.
 */
import { memo, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  LinearProgress,
  List,
  ListItem,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { useAndroidReleases, type AndroidAppWriteError } from '../../../hooks/useAndroidApp';
import {
  ANDROID_APP_ERROR,
  ANDROID_RELEASE_PACKAGE_NAME,
  MAX_APK_BYTES,
  MAX_RELEASE_NOTES_LENGTH,
  MAX_VERSION_CODE,
  MAX_VERSION_NAME_LENGTH,
  VERSION_NAME_PATTERN,
  isValidFingerprint,
  isValidPackageName,
  normalizeSha256,
  parseReleaseSidecar,
  type AdminRelease,
  type AndroidAppConfig,
  type ReleaseSidecar,
} from '../../../services/androidApp';
import { formatBytes } from '../../../utils/formatBytes';
import { formatRelativeTime } from '../../../utils/runFormat';

export const CLI_RELEASE_COMMAND = 'memoriahub android release --bump patch';
export const CLI_BUMP_COMMAND = 'memoriahub android version --bump patch';
export const NOT_NEWER_MESSAGE =
  'This build is not newer than the current release. Phones only install a higher version code, so they will not be offered it.';
export const VERSION_EXISTS_MESSAGE =
  'A release with this version code already exists for this package. Bump the version and build again:';
export const READ_ONLY_REASON = 'Needs permission to change system settings';

const MONO = { fontFamily: 'monospace', fontSize: '0.8rem', overflowWrap: 'anywhere' } as const;

const isApk = (file: File) => /\.apk$/i.test(file.name);
const isJson = (file: File) => /\.json$/i.test(file.name);

/** The one signing fingerprint the trusted list holds, or `''` when there are none or several. */
export function soleTrustedSigner(config: AndroidAppConfig | null): string {
  if (!config) return '';
  const shas = new Set(config.trustedApps.map((app) => normalizeSha256(app.sha256)));
  return shas.size === 1 ? [...shas][0] : '';
}

interface FormState {
  apk: File | null;
  versionName: string;
  versionCode: string;
  packageName: string;
  signingSha256: string;
  notes: string;
  makeCurrent: boolean;
}

type FormErrors = Partial<Record<keyof FormState, string>>;

export function validateReleaseForm(form: FormState): FormErrors {
  const errors: FormErrors = {};
  if (!form.apk) errors.apk = 'Choose the APK file.';
  else if (!isApk(form.apk)) errors.apk = 'The file must be an .apk.';
  else if (form.apk.size > MAX_APK_BYTES) errors.apk = 'The APK is larger than the 150 MiB limit.';

  const name = form.versionName.trim();
  if (!name) errors.versionName = 'Enter the version name, such as 2.0.1.';
  else if (name.length > MAX_VERSION_NAME_LENGTH) errors.versionName = `At most ${MAX_VERSION_NAME_LENGTH} characters.`;
  else if (!VERSION_NAME_PATTERN.test(name)) {
    errors.versionName = 'Letters, digits, ".", "_", "+" and "-" only, starting with a letter or digit.';
  }

  const codeText = form.versionCode.trim();
  const code = Number(codeText);
  if (!/^\d+$/.test(codeText) || code < 1 || code > MAX_VERSION_CODE) {
    errors.versionCode = `A whole number from 1 to ${MAX_VERSION_CODE.toLocaleString('en-US')}.`;
  }
  if (!isValidPackageName(form.packageName)) {
    errors.packageName = 'Enter an Android package name, such as memoriahub.marin.cr.';
  }
  if (!isValidFingerprint(form.signingSha256)) {
    errors.signingSha256 = 'Enter a SHA-256 fingerprint: 32 colon-separated hex pairs, or 64 hex digits.';
  }
  if (form.notes.length > MAX_RELEASE_NOTES_LENGTH) errors.notes = `At most ${MAX_RELEASE_NOTES_LENGTH} characters.`;
  return errors;
}

type Confirm = { kind: 'rollback' | 'delete'; release: AdminRelease } | null;

interface AndroidReleasesSectionProps {
  canWrite: boolean;
  config: AndroidAppConfig | null;
  /** Called after a write that may have trusted a signer server-side (upload as current, make current). */
  onTrustMayHaveChanged?: () => void;
}

function uploaderName(release: AdminRelease): string {
  if (!release.uploadedBy) return 'a deleted user';
  return release.uploadedBy.displayName || release.uploadedBy.email;
}

/** Memoized: the page re-renders on every keystroke in the trusted-keys form. */
export const AndroidReleasesSection = memo(function AndroidReleasesSection({
  canWrite,
  config,
  onTrustMayHaveChanged,
}: AndroidReleasesSectionProps) {
  const { releases, isLoading, error, busyId, isUploading, progress, upload, makeCurrent, remove } =
    useAndroidReleases();
  const current = releases.find((r) => r.isCurrent) ?? null;

  // Until the admin types one (or a sidecar sets it), the signer follows the
  // current release (same keystore, the common case), else the sole trusted key.
  const knownSigner = useMemo(
    () => (current ? current.signingSha256 : soleTrustedSigner(config)),
    [current, config],
  );

  const emptyForm = (): FormState => ({
    apk: null,
    versionName: '',
    versionCode: '',
    packageName: ANDROID_RELEASE_PACKAGE_NAME,
    signingSha256: '',
    notes: '',
    makeCurrent: true,
  });
  const [form, setForm] = useState<FormState>(emptyForm);
  const [signerTouched, setSignerTouched] = useState(false);
  const signingSha256 = signerTouched ? form.signingSha256 : knownSigner;

  const [errors, setErrors] = useState<FormErrors>({});
  const [uploadError, setUploadError] = useState<AndroidAppWriteError | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sidecar, setSidecar] = useState<{ name: string; meta: ReleaseSidecar } | null>(null);
  const [sidecarError, setSidecarError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const writeDisabled = !canWrite || isUploading;
  const disabledReason = canWrite ? '' : READ_ONLY_REASON;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const applySidecar = (meta: ReleaseSidecar) => {
    setForm((f) => ({
      ...f,
      versionName: meta.versionName ?? f.versionName,
      versionCode: meta.versionCode !== undefined ? String(meta.versionCode) : f.versionCode,
      packageName: meta.packageName ?? f.packageName,
      signingSha256: meta.signingSha256 ?? f.signingSha256,
    }));
    if (meta.signingSha256) setSignerTouched(true);
  };

  const takeFiles = async (files: File[]) => {
    for (const file of files) {
      if (isJson(file)) {
        const meta = parseReleaseSidecar(await file.text());
        if (meta) {
          applySidecar(meta);
          setSidecar({ name: file.name, meta });
          setSidecarError(null);
        } else {
          setSidecar(null);
          setSidecarError(`${file.name} is not a release sidecar from memoriahub android build.`);
        }
      } else {
        set('apk', file);
        setErrors((e) => ({ ...e, apk: undefined }));
      }
    }
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void takeFiles(files);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (writeDisabled) return;
    void takeFiles(Array.from(event.dataTransfer.files ?? []));
  };

  // The sidecar describes one specific build; a different APK beside it is a mistake worth flagging.
  const sizeMismatch =
    sidecar?.meta.sizeBytes !== undefined && form.apk !== null && form.apk.size !== sidecar.meta.sizeBytes;

  const submit = async (force: boolean) => {
    const values = { ...form, signingSha256 };
    const found = validateReleaseForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0 || !values.apk) return;
    setUploadError(null);
    setNotice(null);
    const result = await upload({
      apk: values.apk,
      packageName: values.packageName.trim(),
      versionName: values.versionName.trim(),
      versionCode: Number(values.versionCode.trim()),
      signingSha256: normalizeSha256(values.signingSha256),
      notes: values.notes,
      makeCurrent: values.makeCurrent,
      force,
    });
    if (result.ok) {
      setNotice(
        `Uploaded ${result.value.versionName} (${result.value.versionCode})` +
          (result.value.isCurrent ? ' and made it the current release.' : '.'),
      );
      setForm(emptyForm());
      setSignerTouched(false);
      setSidecar(null);
      setSidecarError(null);
      if (result.value.isCurrent) onTrustMayHaveChanged?.();
    } else {
      setUploadError(result.error);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(false);
  };

  const doMakeCurrent = async (release: AdminRelease) => {
    setRowError(null);
    setNotice(null);
    const result = await makeCurrent(release.id);
    if (result.ok) {
      setNotice(`${release.versionName} is now the current release.`);
      onTrustMayHaveChanged?.();
    } else {
      setRowError(result.error.message);
    }
  };

  const doDelete = async (release: AdminRelease) => {
    setRowError(null);
    setNotice(null);
    const result = await remove(release.id);
    if (result.ok) setNotice(`Deleted ${release.versionName}.`);
    else setRowError(result.error.message);
  };

  const requestMakeCurrent = (release: AdminRelease) => {
    if (current && release.versionCode < current.versionCode) setConfirm({ kind: 'rollback', release });
    else void doMakeCurrent(release);
  };

  const confirmAction = () => {
    if (!confirm) return;
    const { kind, release } = confirm;
    setConfirm(null);
    if (kind === 'rollback') void doMakeCurrent(release);
    else void doDelete(release);
  };

  const percent = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;

  let list;
  if (isLoading && releases.length === 0) {
    list = <Skeleton variant="rounded" height={80} />;
  } else if (error && releases.length === 0) {
    list = <Alert severity="error">{error}</Alert>;
  } else if (releases.length === 0) {
    list = (
      <Typography variant="body2" color="text.secondary">
        No release uploaded yet. Users see &ldquo;No Android release has been published yet&rdquo; until one is.
      </Typography>
    );
  } else {
    list = (
      <List dense disablePadding aria-label="Releases">
        {releases.map((release) => {
          const busy = busyId === release.id;
          return (
            <ListItem
              key={release.id}
              divider
              disableGutters
              sx={{ display: 'block', minWidth: 0 }}
              data-testid={`release-${release.versionCode}`}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="subtitle1" component="span">
                  {release.versionName}
                </Typography>
                <Typography variant="body2" color="text.secondary" component="span">
                  code {release.versionCode}
                </Typography>
                {release.isCurrent && <Chip size="small" color="success" label="Current" />}
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                {release.packageName} · {formatBytes(release.sizeBytes)} · uploaded{' '}
                {formatRelativeTime(release.createdAt)}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 0.5, flexWrap: 'wrap' }}>
                {!release.isCurrent && (
                  <Tooltip title={disabledReason}>
                    <span>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={!canWrite || busyId !== null}
                        onClick={() => requestMakeCurrent(release)}
                        aria-label={`Make ${release.versionName} current`}
                        startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
                      >
                        Make current
                      </Button>
                    </span>
                  </Tooltip>
                )}
                <Tooltip
                  title={
                    release.isCurrent ? 'The current release cannot be deleted' : disabledReason || 'Delete'
                  }
                >
                  <span>
                    <IconButton
                      size="small"
                      aria-label={`Delete ${release.versionName}`}
                      disabled={!canWrite || release.isCurrent || busyId !== null}
                      onClick={() => setConfirm({ kind: 'delete', release })}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            </ListItem>
          );
        })}
      </List>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }} component="section" aria-labelledby="android-releases-title">
      <Typography variant="h6" component="h2" id="android-releases-title" gutterBottom>
        Releases
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        The APK users download from Settings → Android app. Publish from a MemoriaHub checkout with{' '}
        <Box component="code" sx={{ overflowWrap: 'anywhere' }}>
          {CLI_RELEASE_COMMAND}
        </Box>
        , or upload a build here.
      </Typography>

      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {rowError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setRowError(null)}>
          {rowError}
        </Alert>
      )}

      {current && (
        <Paper
          variant="outlined"
          sx={{ p: 2, mb: 2, bgcolor: 'action.hover', minWidth: 0 }}
          aria-label="Current release"
          data-testid="current-release"
        >
          <Typography variant="overline" color="text.secondary">
            Current release
          </Typography>
          <Typography variant="h6" component="p">
            {current.versionName}{' '}
            <Typography component="span" variant="body2" color="text.secondary">
              (code {current.versionCode})
            </Typography>
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {current.packageName} · {formatBytes(current.sizeBytes)} · uploaded by {uploaderName(current)}{' '}
            {formatRelativeTime(current.createdAt)}
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            Signing certificate SHA-256
          </Typography>
          <Box component="span" sx={{ ...MONO, display: 'block' }}>
            {current.signingSha256}
          </Box>
          {current.notes && (
            <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {current.notes}
            </Typography>
          )}
        </Paper>
      )}

      {list}

      <Box
        component="form"
        onSubmit={onSubmit}
        noValidate
        aria-label="Upload a release"
        onDragOver={(e: DragEvent) => {
          e.preventDefault();
          if (!writeDisabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        sx={{
          mt: 3,
          p: 2,
          border: 1,
          borderStyle: 'dashed',
          borderColor: dragging ? 'primary.main' : 'divider',
          borderRadius: 1,
          minWidth: 0,
        }}
      >
        <Typography variant="subtitle1" component="h3" gutterBottom>
          Upload a release
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Drop the APK here, together with the <code>.json</code> file <code>memoriahub android build</code> writes next
          to it in <code>dist/android/</code> to fill in the fields.
        </Typography>
        <Stack spacing={1.5}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept=".apk,application/vnd.android.package-archive,.json,application/json"
              onChange={onPick}
              data-testid="release-file-input"
              aria-label="APK and sidecar files"
              disabled={writeDisabled}
            />
            <Tooltip title={disabledReason}>
              <span>
                <Button
                  variant="outlined"
                  startIcon={<UploadFileIcon />}
                  onClick={() => fileInput.current?.click()}
                  disabled={writeDisabled}
                >
                  Choose APK and sidecar
                </Button>
              </span>
            </Tooltip>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere', minWidth: 0 }} data-testid="release-file-name">
              {form.apk ? `${form.apk.name} · ${formatBytes(String(form.apk.size))}` : 'No APK chosen'}
            </Typography>
          </Box>
          {errors.apk && (
            <Typography variant="caption" color="error">
              {errors.apk}
            </Typography>
          )}
          {sidecar && <Alert severity="info">Filled in from {sidecar.name}.</Alert>}
          {sidecarError && <Alert severity="warning">{sidecarError}</Alert>}
          {sizeMismatch && (
            <Alert severity="warning" data-testid="sidecar-size-mismatch">
              The APK is a different size than {sidecar?.name} describes. Check that they come from the same build.
            </Alert>
          )}
          <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <TextField
              label="Version name"
              size="small"
              value={form.versionName}
              onChange={(e) => set('versionName', e.target.value)}
              error={Boolean(errors.versionName)}
              helperText={errors.versionName}
              disabled={writeDisabled}
            />
            <TextField
              label="Version code"
              size="small"
              value={form.versionCode}
              onChange={(e) => set('versionCode', e.target.value)}
              error={Boolean(errors.versionCode)}
              helperText={errors.versionCode ?? (current ? `Current: ${current.versionCode}` : undefined)}
              disabled={writeDisabled}
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
            />
          </Box>
          <TextField
            label="Package name"
            size="small"
            value={form.packageName}
            onChange={(e) => set('packageName', e.target.value)}
            error={Boolean(errors.packageName)}
            helperText={errors.packageName}
            disabled={writeDisabled}
            fullWidth
          />
          <TextField
            label="Signing certificate SHA-256"
            size="small"
            value={signingSha256}
            onChange={(e) => {
              setSignerTouched(true);
              set('signingSha256', e.target.value);
            }}
            error={Boolean(errors.signingSha256)}
            helperText={errors.signingSha256 ?? 'Making the release current also trusts this signer.'}
            disabled={writeDisabled}
            fullWidth
            slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
          />
          <TextField
            label="Release notes"
            size="small"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            error={Boolean(errors.notes)}
            helperText={errors.notes}
            disabled={writeDisabled}
            multiline
            minRows={2}
            fullWidth
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={form.makeCurrent}
                onChange={(e) => set('makeCurrent', e.target.checked)}
                disabled={writeDisabled}
              />
            }
            label="Make it the current release"
          />
          {isUploading && (
            <Box>
              <LinearProgress variant="determinate" value={percent} aria-label="Upload progress" />
              <Typography variant="caption" color="text.secondary">
                Uploading… {percent}%
              </Typography>
            </Box>
          )}
          {uploadError?.reason === ANDROID_APP_ERROR.RELEASE_VERSION_NOT_NEWER && (
            <Alert
              severity="warning"
              data-testid="upload-not-newer"
              action={
                <Button color="inherit" size="small" onClick={() => void submit(true)} disabled={writeDisabled}>
                  Upload anyway (force)
                </Button>
              }
            >
              {NOT_NEWER_MESSAGE}
            </Alert>
          )}
          {uploadError?.reason === ANDROID_APP_ERROR.RELEASE_VERSION_EXISTS && (
            <Alert severity="error" data-testid="upload-version-exists">
              {VERSION_EXISTS_MESSAGE}{' '}
              <Box component="code" sx={{ overflowWrap: 'anywhere' }}>
                {CLI_BUMP_COMMAND}
              </Box>
            </Alert>
          )}
          {uploadError &&
            uploadError.reason !== ANDROID_APP_ERROR.RELEASE_VERSION_NOT_NEWER &&
            uploadError.reason !== ANDROID_APP_ERROR.RELEASE_VERSION_EXISTS && (
              <Alert severity="error">{uploadError.message}</Alert>
            )}
          <Box>
            <Tooltip title={disabledReason}>
              <span>
                <Button
                  type="submit"
                  variant="contained"
                  disabled={writeDisabled}
                  startIcon={isUploading ? <CircularProgress size={16} color="inherit" /> : undefined}
                >
                  {isUploading ? 'Uploading…' : 'Upload release'}
                </Button>
              </span>
            </Tooltip>
          </Box>
        </Stack>
      </Box>

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} aria-labelledby="release-confirm-title">
        <DialogTitle id="release-confirm-title">
          {confirm?.kind === 'rollback'
            ? `Roll back to ${confirm.release.versionName}?`
            : `Delete ${confirm?.release.versionName ?? ''}?`}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirm?.kind === 'rollback'
              ? `Phones on ${current?.versionName ?? 'the current release'} will not downgrade automatically; ` +
                `users must reinstall. Version code ${confirm.release.versionCode} is lower than the current ` +
                `${current?.versionCode ?? ''}, and Android refuses to install a lower version over a higher one.`
              : 'The APK file is deleted from storage. Users can no longer download this version.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button onClick={confirmAction} color={confirm?.kind === 'delete' ? 'error' : 'warning'} variant="contained">
            {confirm?.kind === 'rollback' ? 'Roll back' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
});
