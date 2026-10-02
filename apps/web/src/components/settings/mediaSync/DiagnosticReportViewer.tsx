/**
 * One uploaded diagnostic report (issue #515, spec §13): the self-test checks
 * sorted fail, warn, pass (skip last) with detail and remedy, the key
 * environment facts, the log tail, and the whole report as collapsible raw
 * JSON. Renders whatever the phone sent; an older or newer app build may send
 * more or less, so every field is read defensively.
 */
import { useState } from 'react';
import {
  Box,
  Button,
  Collapse,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorIcon from '@mui/icons-material/Error';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutlineOutlined';
import type { MediaSyncReport } from '../../../services/mediaSync';
import { CHECK_STATUS_LABELS, formatDateTime, type DiagnosticCheckStatus } from './format';

const LOG_TAIL_LINES = 100;

/** Screen-reader-only text (MUI's `visuallyHidden` shape). */
const VISUALLY_HIDDEN = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const;

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: DiagnosticCheckStatus;
  detail: string | null;
  remedy: string | null;
}

const STATUS_ORDER: Record<DiagnosticCheckStatus, number> = { fail: 0, warn: 1, pass: 2, skip: 3 };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** The report's checks, normalised and sorted fail → warn → pass → skip. Exported for tests. */
export function sortedChecks(report: Record<string, unknown>): DiagnosticCheck[] {
  const raw = Array.isArray(report.checks) ? report.checks : [];
  const checks = raw.map((value, index): DiagnosticCheck => {
    const c = asRecord(value);
    const status = asText(c.status);
    return {
      id: asText(c.id) ?? `check-${index}`,
      label: asText(c.label) ?? asText(c.id) ?? 'Check',
      status: status === 'pass' || status === 'warn' || status === 'fail' ? status : 'skip',
      detail: asText(c.detail),
      remedy: asText(c.remedy),
    };
  });
  return checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => STATUS_ORDER[a.c.status] - STATUS_ORDER[b.c.status] || a.i - b.i)
    .map(({ c }) => c);
}

function CheckIcon({ status }: { status: DiagnosticCheckStatus }) {
  const label = CHECK_STATUS_LABELS[status];
  switch (status) {
    case 'pass':
      return <CheckCircleIcon color="success" titleAccess={label} data-testid="check-icon-pass" />;
    case 'warn':
      return <WarningAmberIcon color="warning" titleAccess={label} data-testid="check-icon-warn" />;
    case 'fail':
      return <ErrorIcon color="error" titleAccess={label} data-testid="check-icon-fail" />;
    default:
      return <RemoveCircleOutlineIcon color="disabled" titleAccess={label} data-testid="check-icon-skip" />;
  }
}

function join(...parts: Array<string | null | undefined>): string {
  return parts.filter((p) => p !== null && p !== undefined && p !== '').join(' · ');
}

export function DiagnosticReportViewer({ report }: { report: MediaSyncReport }) {
  const [showRaw, setShowRaw] = useState(false);
  const body = asRecord(report.report);
  const checks = sortedChecks(body);
  const app = asRecord(body.app);
  const device = asRecord(body.device);
  const stats = asRecord(body.stats);
  const logSource = Array.isArray(body.log) ? body.log : Array.isArray(body.logTail) ? body.logTail : [];
  const log = logSource.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).slice(-LOG_TAIL_LINES);
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) counts[c.status] += 1;

  const facts: Array<[string, string]> = [
    ['App', join(asText(app.versionName), asText(app.versionCode) ? `build ${asText(app.versionCode)}` : null, asText(app.packageName))],
    [
      'Device',
      join(
        join(asText(device.manufacturer), asText(device.model)),
        asText(device.androidVersion) ? `Android ${asText(device.androidVersion)}` : null,
        asText(device.sdkInt) ? `SDK ${asText(device.sdkInt)}` : null,
      ),
    ],
    [
      'Ledger',
      join(
        asText(stats.eligible) ? `${asText(stats.eligible)} eligible` : null,
        asText(stats.uploaded) ? `${asText(stats.uploaded)} uploaded` : null,
        asText(stats.pending) ? `${asText(stats.pending)} pending` : null,
        asText(stats.failed) ? `${asText(stats.failed)} failed` : null,
      ),
    ],
  ];

  return (
    <Stack spacing={2} data-testid="diagnostic-report">
      <Box>
        <Typography variant="subtitle2">Uploaded {formatDateTime(report.createdAt)}</Typography>
        {report.summary && (
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {report.summary}
          </Typography>
        )}
        {checks.length > 0 && (
          <Typography variant="body2" color="text.secondary" data-testid="check-counts">
            {counts.fail} failed · {counts.warn} warnings · {counts.pass} passed
          </Typography>
        )}
      </Box>

      <Box>
        <Typography variant="subtitle1" component="h3">
          Checks
        </Typography>
        {checks.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            This report has no self-test results.
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small" aria-label="Self-test checks">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Box component="span" sx={VISUALLY_HIDDEN}>
                      Status
                    </Box>
                  </TableCell>
                  <TableCell>Check</TableCell>
                  <TableCell>Detail</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {checks.map((check) => (
                  <TableRow key={check.id} data-testid={`check-row-${check.status}`}>
                    <TableCell padding="checkbox">
                      <CheckIcon status={check.status} />
                    </TableCell>
                    <TableCell sx={{ verticalAlign: 'top' }}>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {check.label}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ verticalAlign: 'top', overflowWrap: 'anywhere' }}>
                      {check.detail && <Typography variant="body2">{check.detail}</Typography>}
                      {check.remedy && (
                        <Typography variant="body2" color="text.secondary">
                          Fix: {check.remedy}
                        </Typography>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>

      <Box>
        <Typography variant="subtitle1" component="h3">
          Environment
        </Typography>
        <Box component="dl" sx={{ m: 0 }}>
          {facts
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <Box key={label} sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Typography component="dt" variant="body2" sx={{ fontWeight: 500 }}>
                  {label}:
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere' }}>
                  {value}
                </Typography>
              </Box>
            ))}
        </Box>
      </Box>

      {log.length > 0 && (
        <Box>
          <Typography variant="subtitle1" component="h3">
            Log (last {log.length} lines)
          </Typography>
          <Box
            component="pre"
            tabIndex={0}
            aria-label="Log tail"
            sx={{ m: 0, p: 1, maxHeight: 240, overflow: 'auto', fontFamily: 'monospace', fontSize: '0.75rem', bgcolor: 'action.hover', borderRadius: 1 }}
          >
            {log.join('\n')}
          </Box>
        </Box>
      )}

      <Box>
        <Button size="small" onClick={() => setShowRaw((v) => !v)} aria-expanded={showRaw} sx={{ px: 0 }}>
          {showRaw ? 'Hide raw JSON' : 'Show raw JSON'}
        </Button>
        <Collapse in={showRaw} unmountOnExit>
          <Box
            component="pre"
            tabIndex={0}
            aria-label="Raw report JSON"
            data-testid="raw-report-json"
            sx={{ m: 0, mt: 1, p: 1, maxHeight: 360, overflow: 'auto', fontFamily: 'monospace', fontSize: '0.75rem', bgcolor: 'action.hover', borderRadius: 1 }}
          >
            {JSON.stringify(report.report, null, 2)}
          </Box>
        </Collapse>
      </Box>
    </Stack>
  );
}
