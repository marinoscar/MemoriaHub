/**
 * A phone's uploaded diagnostic reports (issue #515): the list, newest first,
 * and a viewer dialog that loads one report's body on demand (full screen
 * below `sm`). Inside the TWA, a deep link runs the self-test on this phone.
 */
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
  Skeleton,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import {
  getDeviceDiagnostic,
  mediaSyncErrorMessage,
  type MediaSyncReport,
  type MediaSyncReportSummary,
} from '../../../services/mediaSync';
import { useDeviceDiagnostics } from '../../../hooks/useMediaSync';
import { useIsMounted } from '../../../hooks/useIsMounted';
import { mediaSyncDeepLink } from '../../../utils/androidIdentity';
import { DiagnosticReportViewer } from './DiagnosticReportViewer';
import { formatDateTime } from './format';

export function DiagnosticsSection({ deviceId, inTwa }: { deviceId: string; inTwa: boolean }) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const { reports, isLoading, error, refresh } = useDeviceDiagnostics(deviceId, true);
  const [open, setOpen] = useState<MediaSyncReportSummary | null>(null);
  const [report, setReport] = useState<MediaSyncReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const view = async (summary: MediaSyncReportSummary) => {
    setOpen(summary);
    setReport(null);
    setReportError(null);
    try {
      const loaded = await getDeviceDiagnostic(deviceId, summary.id);
      if (isMounted()) setReport(loaded);
    } catch (err) {
      if (isMounted()) setReportError(mediaSyncErrorMessage(err, 'Failed to load the report'));
    }
  };

  let body;
  if (isLoading && reports.length === 0) {
    body = <Skeleton width="70%" />;
  } else if (error && reports.length === 0) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void refresh()}>
            Retry
          </Button>
        }
      >
        {error}
      </Alert>
    );
  } else if (reports.length === 0) {
    body = (
      <Typography variant="body2" color="text.secondary">
        No reports yet. On the phone, open Media sync → Diagnostics → Upload report.
      </Typography>
    );
  } else {
    body = (
      <List dense disablePadding aria-label="Diagnostic reports">
        {reports.map((summary) => (
          <ListItem
            key={summary.id}
            divider
            disableGutters
            secondaryAction={
              <Button
                size="small"
                onClick={() => void view(summary)}
                aria-label={`View report from ${formatDateTime(summary.createdAt)}`}
              >
                View
              </Button>
            }
          >
            <ListItemText
              primary={formatDateTime(summary.createdAt)}
              secondary={summary.summary ?? 'No summary'}
              sx={{ pr: 8, overflowWrap: 'anywhere' }}
            />
          </ListItem>
        ))}
      </List>
    );
  }

  return (
    <Box>
      {body}
      {inTwa && (
        <Button
          size="small"
          href={mediaSyncDeepLink('diagnostics')}
          startIcon={<PhoneAndroidIcon />}
          sx={{ mt: 1, minHeight: 40 }}
        >
          Run diagnostics on this phone
        </Button>
      )}
      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        fullScreen={isCompactWindow}
        fullWidth
        maxWidth="md"
        aria-labelledby="diagnostic-report-title"
      >
        <DialogTitle id="diagnostic-report-title">Diagnostic report</DialogTitle>
        <DialogContent dividers>
          {reportError ? (
            <Alert severity="error">{reportError}</Alert>
          ) : report ? (
            <DiagnosticReportViewer report={report} />
          ) : (
            <Skeleton width="80%" />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
