/**
 * Restore-from-backup dialog (issue #345, epic #339; consumes #344).
 *
 * ## What this dialog has to get right
 *
 * A restore here is NOT the in-place `pg_restore --clean` that #344 explicitly
 * rejected. It restores into a fresh scratch database in the same cluster while
 * **the app stays fully up and serving**, then swaps with two `ALTER DATABASE …
 * RENAME`s — a window measured in SECONDS. So the honest message is "hours of
 * rebuilding, online" plus "a brief restart", NOT "hours of downtime". Warning
 * about an outage that no longer exists would push admins into scheduling
 * maintenance windows they don't need, or into avoiding restores entirely.
 *
 * ## Why pre-flight is split into two sections
 *
 * The merged #344 API has **no read-only pre-flight endpoint** — the only
 * source of a `RestorePreflightReport` is `POST /runs/:id/restore`, which also
 * requires the typed confirmation. It is nonetheless safe to call: a failed
 * capability gate returns `mode:'guided'` and a failed schema gate returns
 * `mode:'blocked'`, and NEITHER creates a database, renames anything, or
 * touches the live data.
 *
 * Rather than pretend a dry run exists, the dialog does what it honestly can:
 *
 *  1. **Readiness** — checks computable from data already on screen (artifact
 *     completed, verified, checksum recorded, storage location recorded, no
 *     other restore in flight). These render BEFORE the confirmation field and
 *     hard-gate it, so the common failure cases are caught without a request.
 *  2. **Server pre-flight** — `CREATEDB`, free disk vs. the selected rollback
 *     mode, pgvector, artifact re-verification, and schema compatibility. These
 *     arrive with the response and are rendered as RESULTS: `guided` and
 *     `blocked` are designed paths, not error states.
 *
 * The submit button says exactly what it does, because it does two things at
 * once and hiding that would be the dishonest part.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  CheckCircle as OkIcon,
  Error as BlockedIcon,
  MenuBook as RunbookIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';
import {
  RESTORE_CONFIRMATION,
  RESTORE_RUNBOOK_PATH,
  RESTORE_RUNBOOK_URL,
} from '../../services/dbBackup';
import type {
  DbBackupConfig,
  DbBackupRollbackMode,
  DbBackupRunDto,
  DbRestorePreflightCheck,
  DbRestorePreflightStatus,
  StartDbRestoreResult,
} from '../../services/dbBackup';
import { formatBytes } from '../../utils/formatBytes';

// ---------------------------------------------------------------------------
// Readiness — the pre-flight half computable without a request
// ---------------------------------------------------------------------------

export interface ReadinessCheck {
  key: string;
  label: string;
  ok: boolean;
  message: string;
}

/**
 * Client-side gates, evaluated from the run row already in hand.
 *
 * Every one of these would otherwise come back as a 400 AFTER the admin typed
 * `RESTORE` — the exact "allow confirmation, then fail" shape the issue calls
 * out. Blocking the confirmation field on them instead costs one render and
 * removes a whole class of dead-end interactions.
 */
export function buildReadinessChecks(
  run: DbBackupRunDto,
  opts: { restoreInFlight: boolean },
): ReadinessCheck[] {
  return [
    {
      key: 'artifact.completed',
      label: 'Backup completed',
      ok: run.status === 'completed',
      message:
        run.status === 'completed'
          ? 'This backup finished successfully.'
          : `This backup is "${run.status}" — only a completed dump can be restored.`,
    },
    {
      key: 'artifact.verified',
      label: 'Archive verified at backup time',
      ok: !!run.verifiedAt,
      message: run.verifiedAt
        ? 'The archive was streamed back through pg_restore --list when it was written.'
        : 'This archive was never verified after upload. It may not be readable; the server re-verifies it before restoring either way.',
    },
    {
      key: 'artifact.checksum',
      label: 'Checksum recorded',
      ok: !!run.checksumSha256,
      message: run.checksumSha256
        ? 'A sha256 is on file to re-check the downloaded bytes against.'
        : 'No checksum was recorded, so a corrupted download cannot be detected before the restore starts.',
    },
    {
      key: 'artifact.location',
      label: 'Storage location recorded',
      ok: !!run.storageKey,
      message: run.storageKey
        ? `Stored at ${run.storageProvider ?? 'the recorded provider'}:${run.storageKey}.`
        : 'This run has no recorded storage location, so there is nothing to download.',
    },
    {
      key: 'restore.exclusive',
      label: 'No other restore in progress',
      ok: !opts.restoreInFlight,
      message: opts.restoreInFlight
        ? 'Another restore is already running. Only one restore may be in flight at a time.'
        : 'The restore slot is free.',
    },
  ];
}

/**
 * The reason the action is unavailable, or null when it is available.
 *
 * Exported so the row action and the dialog render the SAME sentence — a
 * disabled control whose tooltip disagrees with the dialog behind it is worse
 * than no tooltip.
 */
export function restoreBlockedReason(
  run: DbBackupRunDto,
  opts: { canRestore: boolean; restoreInFlight: boolean },
): string | null {
  if (!opts.canRestore) {
    return 'Requires the db_backup:restore permission';
  }
  const failed = buildReadinessChecks(run, opts).find((c) => !c.ok);
  // A missing checksum or an unverified archive is a warning, not a gate: the
  // server re-verifies the downloaded bytes regardless, and refusing to restore
  // an unverified archive mid-incident would remove the only path forward.
  if (failed && failed.key !== 'artifact.verified' && failed.key !== 'artifact.checksum') {
    return failed.message;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small renderers
// ---------------------------------------------------------------------------

function statusIcon(status: DbRestorePreflightStatus) {
  if (status === 'ok') return <OkIcon color="success" fontSize="small" />;
  if (status === 'warning') return <WarningIcon color="warning" fontSize="small" />;
  return <BlockedIcon color="error" fontSize="small" />;
}

function CheckRow({
  icon,
  label,
  message,
  actionItem,
}: {
  icon: React.ReactNode;
  label: string;
  message: string;
  actionItem?: string;
}) {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
      <Box sx={{ mt: '2px' }}>{icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {label}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {message}
        </Typography>
        {actionItem && (
          <Typography variant="body2" color="warning.main" sx={{ mt: 0.25 }}>
            {actionItem}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function PreflightChecks({ checks }: { checks: DbRestorePreflightCheck[] }) {
  return (
    <Stack spacing={1.25} data-testid="restore-preflight-checks">
      {checks.map((c) => (
        <CheckRow
          key={c.key}
          icon={statusIcon(c.status)}
          label={c.label}
          message={c.message}
          actionItem={c.actionItem}
        />
      ))}
    </Stack>
  );
}

/**
 * The rollback plan, stated BEFORE confirming.
 *
 * The two modes offer materially different recovery guarantees — seconds vs.
 * hours — and an admin deciding whether to restore right now is deciding on the
 * strength of exactly that. When the disk pre-flight silently downgrades the
 * mode, the guarantee they were counting on has changed, which is why the
 * downgrade gets its own warning rather than a quiet swap of wording.
 */
export function RollbackPlan({
  mode,
  requestedMode,
  downgraded,
  downgradeReason,
  retentionHours,
}: {
  mode: DbBackupRollbackMode;
  requestedMode?: DbBackupRollbackMode;
  downgraded?: boolean;
  downgradeReason?: string | null;
  retentionHours: number;
}) {
  return (
    <Box>
      <Typography variant="subtitle2" gutterBottom>
        If you need to undo this
      </Typography>
      {mode === 'retain_database' ? (
        <Typography variant="body2" color="text.secondary">
          The current database is renamed and <strong>kept</strong>, so you can
          roll back in <strong>seconds</strong> for {retentionHours} hours after
          the swap (roughly {Math.round(retentionHours / 24)} day
          {Math.round(retentionHours / 24) === 1 ? '' : 's'}). After that it is
          dropped and rolling back means a full restore.
        </Typography>
      ) : (
        <Typography variant="body2" color="text.secondary">
          A <strong>pre-restore backup is taken first</strong>, and nothing is
          kept on disk. Rolling back therefore means running another full
          restore — <strong>hours</strong>, not seconds.
        </Typography>
      )}

      {downgraded && (
        <Alert severity="warning" sx={{ mt: 1.5 }} data-testid="rollback-downgrade">
          <AlertTitle>Rollback mode was downgraded automatically</AlertTitle>
          You configured{' '}
          <strong>
            {requestedMode === 'retain_database'
              ? 'keep the old database (fast rollback)'
              : 'pre-restore dump'}
          </strong>
          , but there is not enough free disk for it, so the restore will use{' '}
          <strong>
            {mode === 'retain_database'
              ? 'keep the old database'
              : 'a pre-restore dump'}
          </strong>{' '}
          instead. <strong>Your recovery guarantee has changed from seconds to
          hours.</strong>
          {downgradeReason ? ` ${downgradeReason}` : ''}
        </Alert>
      )}
    </Box>
  );
}

/**
 * The guided fallback.
 *
 * A capability gate (no `CREATEDB`, no pgvector, no cluster admin connection)
 * cannot be overridden by intent — managed Postgres routinely denies `CREATEDB`
 * — so the designed outcome is a ready-to-paste command block, not an error
 * toast. The failed check is named, because "run these commands" without saying
 * what failed gives an admin nothing to fix or to escalate.
 */
export function GuidedRestoreBlock({
  reason,
  commands,
  notes,
  failedChecks,
}: {
  reason: string;
  commands: string[];
  notes: string[];
  failedChecks: DbRestorePreflightCheck[];
}) {
  const [copied, setCopied] = useState(false);
  const script = commands.join('\n');

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(script).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }, [script]);

  return (
    <Box data-testid="guided-restore-block">
      <Alert severity="info" sx={{ mb: 2 }}>
        <AlertTitle>This restore has to be run by hand</AlertTitle>
        {reason}
        {failedChecks.length > 0 && (
          <Box component="ul" sx={{ pl: 2.5, my: 1 }}>
            {failedChecks.map((c) => (
              <li key={c.key}>
                <strong>{c.label}</strong> — {c.message}
              </li>
            ))}
          </Box>
        )}
        Nothing has been created or changed. The commands below do the same work
        this page would have driven.
      </Alert>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Run these on the database host
        </Typography>
        <Button size="small" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </Box>
      <Paper
        variant="outlined"
        sx={{
          p: 1.5,
          bgcolor: 'action.hover',
          overflowX: 'auto',
          maxWidth: '100%',
        }}
      >
        <Box
          component="pre"
          sx={{ m: 0, fontSize: 13, fontFamily: 'monospace', whiteSpace: 'pre' }}
        >
          {script}
        </Box>
      </Paper>

      {notes.length > 0 && (
        <Box component="ul" sx={{ pl: 2.5, mt: 1.5, mb: 0 }}>
          {notes.map((n) => (
            <Typography key={n} component="li" variant="body2" color="text.secondary">
              {n}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** The runbook link, rendered wherever a restore is being contemplated. */
export function RunbookLink({ sx }: { sx?: object }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, ...sx }}>
      <RunbookIcon fontSize="small" color="action" />
      <Typography variant="body2">
        <Link href={RESTORE_RUNBOOK_URL} target="_blank" rel="noopener noreferrer">
          Database restore runbook
        </Link>{' '}
        <Typography component="span" variant="body2" color="text.secondary">
          (<code>{RESTORE_RUNBOOK_PATH}</code>) — read it now, not later: the
          situation it exists for is the one where this page is unreachable.
        </Typography>
      </Typography>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export interface DbBackupRestoreDialogProps {
  open: boolean;
  run: DbBackupRunDto | null;
  config: DbBackupConfig | null;
  /** True while any restore is already in flight app-wide. */
  restoreInFlight: boolean;
  onClose: () => void;
  onStart: (
    id: string,
    opts: { overrideSchemaCheck?: boolean },
  ) => Promise<StartDbRestoreResult>;
}

export default function DbBackupRestoreDialog({
  open,
  run,
  config,
  restoreInFlight,
  onClose,
  onStart,
}: DbBackupRestoreDialogProps) {
  const [confirmText, setConfirmText] = useState('');
  const [override, setOverride] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<StartDbRestoreResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset on open so a previous attempt's guided/blocked result never leaks
  // into the next run's dialog.
  useEffect(() => {
    if (open) {
      setConfirmText('');
      setOverride(false);
      setSubmitting(false);
      setResult(null);
      setError(null);
    }
  }, [open, run?.id]);

  const readiness = useMemo(
    () => (run ? buildReadinessChecks(run, { restoreInFlight }) : []),
    [run, restoreInFlight],
  );
  const blockedReason = run
    ? restoreBlockedReason(run, { canRestore: true, restoreInFlight })
    : 'No backup selected';

  const retentionHours = config?.oldDatabaseRetentionHours ?? 168;
  const configuredMode = config?.restoreRollbackMode ?? 'retain_database';

  const preflight = result?.preflight ?? null;
  const effectiveMode = preflight?.rollbackMode ?? configuredMode;

  const confirmationOk = confirmText.trim() === RESTORE_CONFIRMATION;
  const schemaBlocked = result?.mode === 'blocked';
  const guided = result?.mode === 'guided';
  const started = result?.mode === 'running';

  /**
   * A `blocked` result is the one failure an admin may consciously override, so
   * submission re-opens only once they tick the box. A `guided` result never
   * re-opens: no amount of intent conjures a `CREATEDB` privilege.
   */
  const canSubmit =
    !!run &&
    !blockedReason &&
    !submitting &&
    !guided &&
    !started &&
    confirmationOk &&
    (!schemaBlocked || override);

  const submit = useCallback(async () => {
    if (!run) return;
    setSubmitting(true);
    setError(null);
    try {
      const next = await onStart(run.id, { overrideSchemaCheck: override });
      setResult(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start the restore');
    } finally {
      setSubmitting(false);
    }
  }, [run, override, onStart]);

  const failedCapabilityChecks =
    preflight?.checks.filter((c) => c.status === 'blocked') ?? [];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Restore the database from this backup</DialogTitle>
      <DialogContent dividers>
        {!run ? null : (
          <Stack spacing={2.5}>
            {/* ---------------------------------------------------------- */}
            {/* What actually happens — corrected expectations             */}
            {/* ---------------------------------------------------------- */}
            <Alert severity="info">
              <AlertTitle>The app stays online while this runs</AlertTitle>
              The backup is restored into a <strong>separate scratch
              database</strong> while MemoriaHub keeps serving normally from the
              current one. Because a dump stores index definitions rather than
              index data, every vector index is rebuilt from scratch — expect{' '}
              <strong>roughly one to several hours</strong> for a library of this
              size. You can cancel harmlessly at any point during that phase:
              nothing has replaced your live data yet.
              <br />
              <br />
              The only interruption is at the very end — a{' '}
              <strong>database swap and process restart lasting seconds</strong>,
              during which the app is briefly unavailable and this page will show
              &ldquo;restarting&rdquo;.
            </Alert>

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Restoring from
              </Typography>
              <Stack
                direction="row"
                spacing={2}
                useFlexGap
                sx={{ flexWrap: 'wrap', alignItems: 'center' }}
              >
                <Chip size="small" label={`Run ${run.id.slice(0, 8)}`} />
                <Typography variant="body2" color="text.secondary">
                  {run.finishedAt
                    ? new Date(run.finishedAt).toLocaleString()
                    : 'never finished'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {formatBytes(run.sizeBytes ?? run.bytesWritten)}
                </Typography>
                {run.migrationName && (
                  <Typography variant="body2" color="text.secondary">
                    <code>{run.migrationName}</code>
                  </Typography>
                )}
              </Stack>
            </Box>

            <Divider />

            {/* ---------------------------------------------------------- */}
            {/* Readiness — before the confirmation field                  */}
            {/* ---------------------------------------------------------- */}
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Readiness
              </Typography>
              <Stack spacing={1.25} data-testid="restore-readiness-checks">
                {readiness.map((c) => (
                  <CheckRow
                    key={c.key}
                    icon={statusIcon(c.ok ? 'ok' : 'blocked')}
                    label={c.label}
                    message={c.message}
                  />
                ))}
              </Stack>
            </Box>

            {/* ---------------------------------------------------------- */}
            {/* Server pre-flight results                                  */}
            {/* ---------------------------------------------------------- */}
            {preflight && (
              <>
                <Divider />
                <Box>
                  <Typography variant="subtitle2" gutterBottom>
                    Server pre-flight
                  </Typography>
                  <PreflightChecks checks={preflight.checks} />
                </Box>
              </>
            )}

            {schemaBlocked && (
              <Alert severity="error" data-testid="restore-schema-blocked">
                <AlertTitle>Schema compatibility check failed</AlertTitle>
                {result.reason}
                <br />
                <br />
                Nothing has been changed. You can proceed anyway — the archive is
                restored as-is and you then run <code>prisma migrate deploy</code>{' '}
                to bring the schema forward. Do this only if you understand which
                direction the mismatch runs.
                <FormControlLabel
                  sx={{ mt: 1, display: 'block' }}
                  control={
                    <Checkbox
                      checked={override}
                      onChange={(e) => setOverride(e.target.checked)}
                      slotProps={{
                        input: { 'aria-label': 'Override the schema compatibility check' },
                      }}
                    />
                  }
                  label="Restore anyway and run migrations afterwards"
                />
              </Alert>
            )}

            {guided && (
              <GuidedRestoreBlock
                reason={result.guided.reason}
                commands={result.guided.commands}
                notes={result.guided.notes}
                failedChecks={failedCapabilityChecks}
              />
            )}

            {started && (
              <Alert severity="success" data-testid="restore-started">
                <AlertTitle>Restore started</AlertTitle>
                Rebuilding into <code>{result.scratchDatabase}</code>. Progress is
                shown on this page; you can close this dialog and leave — the
                restore continues on the server.
              </Alert>
            )}

            <Divider />

            {/* ---------------------------------------------------------- */}
            {/* Rollback plan, stated before confirming                    */}
            {/* ---------------------------------------------------------- */}
            <RollbackPlan
              mode={effectiveMode}
              requestedMode={preflight?.rollbackModeRequested ?? configuredMode}
              downgraded={preflight?.rollbackModeDowngraded}
              downgradeReason={preflight?.downgradeReason}
              retentionHours={retentionHours}
            />

            <RunbookLink />

            {/* ---------------------------------------------------------- */}
            {/* Confirmation                                               */}
            {/* ---------------------------------------------------------- */}
            {!started && !guided && (
              <Box>
                {blockedReason ? (
                  <Alert severity="warning" data-testid="restore-unavailable">
                    {blockedReason}
                  </Alert>
                ) : (
                  <>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      Type <strong>{RESTORE_CONFIRMATION}</strong> to confirm.
                      Submitting runs the server pre-flight checks and, only if
                      every gate passes, starts the restore immediately.
                    </Typography>
                    <TextField
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      label={`Type ${RESTORE_CONFIRMATION}`}
                      size="small"
                      fullWidth
                      disabled={submitting}
                      slotProps={{
                        htmlInput: { 'aria-label': 'Restore confirmation' },
                      }}
                    />
                  </>
                )}
              </Box>
            )}

            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{started || guided ? 'Close' : 'Cancel'}</Button>
        {!started && !guided && (
          <Button
            variant="contained"
            color="error"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {submitting
              ? 'Checking…'
              : schemaBlocked
                ? 'Restore anyway'
                : 'Run pre-flight and restore'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
