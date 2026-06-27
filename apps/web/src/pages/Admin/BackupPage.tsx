import { useEffect, useState } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Typography,
  Box,
  Paper,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Chip,
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

      {runsError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {runsError}
        </Alert>
      )}

      {runsLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Paper variant="outlined">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Scope</TableCell>
                <TableCell align="right">Copied</TableCell>
                <TableCell align="right">Skipped</TableCell>
                <TableCell align="right">Failed</TableCell>
                <TableCell>Started At</TableCell>
                <TableCell>Completed</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {runs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                      No backup runs found
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                runs.map((run) => (
                  <TableRow key={run.runId}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                        {run.scope}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2">{run.copied}</Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2">{run.skipped}</Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Chip
                        label={run.failed}
                        size="small"
                        color={run.failed > 0 ? 'error' : 'success'}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {new Date(run.startedAt).toLocaleString()}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {run.completedAt ? new Date(run.completedAt).toLocaleString() : '—'}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Paper>
      )}
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
