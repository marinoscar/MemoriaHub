import { useEffect, useState } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Typography,
  Box,
  CircularProgress,
  Alert,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Button,
  Link,
} from '@mui/material';
import { usePermissions } from '../../hooks/usePermissions';
import { useCircles } from '../../hooks/useCircles';
import { useBackup } from '../../hooks/useBackup';
import type { BackupRun } from '../../services/backup';
import { DataTable } from '../../components/datatable';
import { BACKUP_RUNS_TABLE_ID, BACKUP_RUN_COLUMNS } from './backupTable';

function BackupPageContent() {
  const { isAdmin } = usePermissions();
  const { circles, fetchCircles } = useCircles();
  const { runs, runsLoading, runsError, running, runResult, runError, triggerBackup, refreshRuns } =
    useBackup();

  const [scope, setScope] = useState<string>('all');

  useEffect(() => {
    void fetchCircles(true);
  }, [fetchCircles]);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  const handleRunBackup = async () => {
    try {
      await triggerBackup({
        all: scope === 'all',
        circleId: scope !== 'all' ? scope : undefined,
      });
    } catch {
      // error is captured in runError state
    }
  };

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      {/* Back link */}
      <Link
        component={RouterLink}
        to="/admin/settings"
        underline="hover"
        variant="body2"
        sx={{ display: 'inline-block', mb: 2 }}
      >
        &larr; Back to Settings
      </Link>

      <Typography variant="h5" component="h1" sx={{ mb: 3 }}>
        Admin Backup
      </Typography>

      {/* Scope selector */}
      <Box sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <FormControl size="small" sx={{ minWidth: 240 }}>
          <InputLabel id="backup-scope-label">Scope</InputLabel>
          <Select
            labelId="backup-scope-label"
            id="backup-scope"
            value={scope}
            label="Scope"
            onChange={(e) => setScope(e.target.value)}
          >
            <MenuItem value="all">All circles</MenuItem>
            {circles.map((circle) => (
              <MenuItem key={circle.id} value={circle.id}>
                {circle.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {isAdmin && (
          <Button
            variant="contained"
            onClick={() => void handleRunBackup()}
            disabled={running}
            startIcon={running ? <CircularProgress size={20} color="inherit" /> : undefined}
          >
            {running ? 'Running...' : 'Run Backup'}
          </Button>
        )}
      </Box>

      {/* Run result feedback */}
      {runResult && !runError && (
        <Alert severity="success" sx={{ mb: 3 }}>
          <Typography variant="body2" sx={{ fontWeight: 'medium' }}>
            Backup completed — scope: <strong>{runResult.scope}</strong>
          </Typography>
          <Typography variant="body2">
            Copied: {runResult.copied} &nbsp;|&nbsp; Skipped: {runResult.skipped} &nbsp;|&nbsp;
            Failed: {runResult.failed}
          </Typography>
          {runResult.errors.length > 0 && (
            <Box component="ul" sx={{ mt: 1, pl: 2 }}>
              {runResult.errors.map((e, i) => (
                <li key={i}>
                  <Typography variant="caption">{e}</Typography>
                </li>
              ))}
            </Box>
          )}
        </Alert>
      )}

      {runError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {runError}
        </Alert>
      )}

      {/* Recent runs table */}
      <Typography variant="h6" sx={{ mb: 1 }}>
        Recent Runs
      </Typography>

      {/*
        Rendered unconditionally with `loading` as a prop: the overlay draws
        over rows that stay mounted, rather than swapping the whole table for a
        spinner and losing scroll position on every refresh
        (docs/specs/datatable.md §18.4).
      */}
      <DataTable<BackupRun>
        columns={BACKUP_RUN_COLUMNS}
        rows={runs}
        rowId={(run) => run.runId}
        tableId={BACKUP_RUNS_TABLE_ID}
        ariaLabel="Backup runs"
        density="compact"
        loading={runsLoading}
        error={runsError}
        emptyState={<span>No backup runs found</span>}
        csvExport={{ filename: 'backup-runs' }}
      />
    </Container>
  );
}

export default function BackupPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <BackupPageContent />;
}
