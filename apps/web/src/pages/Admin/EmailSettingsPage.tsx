import { useEffect, useState } from 'react';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  Paper,
  Chip,
  TextField,
  FormControlLabel,
  Switch,
  Stack,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  ToggleButton,
  ToggleButtonGroup,
  CircularProgress,
  Alert,
  Snackbar,
  Link,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Email as EmailIcon,
} from '@mui/icons-material';
import { usePermissions } from '../../hooks/usePermissions';
import { useEmailSettings } from '../../hooks/useEmailSettings';
import type {
  EmailProvider,
  TestEmailResult,
  UpdateEmailSettingsBody,
} from '../../services/email';

// Common AWS SES regions.
const SES_REGIONS: { value: string; label: string }[] = [
  { value: 'us-east-1', label: 'US East (N. Virginia) — us-east-1' },
  { value: 'us-east-2', label: 'US East (Ohio) — us-east-2' },
  { value: 'us-west-1', label: 'US West (N. California) — us-west-1' },
  { value: 'us-west-2', label: 'US West (Oregon) — us-west-2' },
  { value: 'eu-west-1', label: 'Europe (Ireland) — eu-west-1' },
  { value: 'eu-west-2', label: 'Europe (London) — eu-west-2' },
  { value: 'eu-central-1', label: 'Europe (Frankfurt) — eu-central-1' },
  { value: 'ap-south-1', label: 'Asia Pacific (Mumbai) — ap-south-1' },
  { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore) — ap-southeast-1' },
  { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney) — ap-southeast-2' },
  { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo) — ap-northeast-1' },
  { value: 'ca-central-1', label: 'Canada (Central) — ca-central-1' },
  { value: 'sa-east-1', label: 'South America (São Paulo) — sa-east-1' },
];

// SMTP provider templates that pre-fill host/port/TLS.
interface SmtpTemplate {
  key: string;
  label: string;
  host: string | null;
  port: number;
  useTls: boolean;
}

const SMTP_TEMPLATES: SmtpTemplate[] = [
  { key: 'gmail', label: 'Gmail', host: 'smtp.gmail.com', port: 587, useTls: true },
  { key: 'm365', label: 'Microsoft 365', host: 'smtp.office365.com', port: 587, useTls: true },
  { key: 'sendgrid', label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, useTls: true },
  { key: 'mailgun', label: 'Mailgun', host: 'smtp.mailgun.org', port: 587, useTls: true },
  {
    key: 'workmail',
    label: 'Amazon WorkMail',
    host: 'email-smtp.us-east-1.amazonaws.com',
    port: 587,
    useTls: true,
  },
  { key: 'custom', label: 'Custom', host: null, port: 587, useTls: true },
];

function EmailSettingsContent() {
  const { settings, loading, error, fetchSettings, saveSettings, sendTest } =
    useEmailSettings();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Shared form state
  const [provider, setProvider] = useState<EmailProvider>('ses');
  const [enabled, setEnabled] = useState(false);
  const [fromAddress, setFromAddress] = useState('');
  const [fromName, setFromName] = useState('');

  // SES form state
  const [sesRegion, setSesRegion] = useState('us-east-1');

  // SMTP form state
  const [smtpTemplate, setSmtpTemplate] = useState('custom');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUseTls, setSmtpUseTls] = useState(true);
  const [smtpUsername, setSmtpUsername] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');

  // Test-connection dialog state
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testRecipient, setTestRecipient] = useState('');
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<TestEmailResult | null>(null);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  // Hydrate form state whenever the settings load.
  useEffect(() => {
    if (!settings) return;
    setProvider(settings.provider ?? 'ses');
    setEnabled(settings.enabled);
    setFromAddress(settings.fromAddress ?? '');
    setFromName(settings.fromName ?? '');
    setSesRegion(settings.sesRegion ?? 'us-east-1');
    setSmtpHost(settings.smtp.host ?? '');
    setSmtpPort(String(settings.smtp.port ?? 587));
    setSmtpUseTls(settings.smtp.useTls);
    setSmtpUsername(settings.smtp.username ?? '');
    setSmtpPassword('');

    // Match a known template to the stored host, else "Custom".
    const matched = SMTP_TEMPLATES.find(
      (t) => t.host && t.host === settings.smtp.host,
    );
    setSmtpTemplate(matched ? matched.key : 'custom');
  }, [settings]);

  const handleTemplateChange = (key: string) => {
    setSmtpTemplate(key);
    const tpl = SMTP_TEMPLATES.find((t) => t.key === key);
    if (!tpl || tpl.key === 'custom') return;
    if (tpl.host) setSmtpHost(tpl.host);
    setSmtpPort(String(tpl.port));
    setSmtpUseTls(tpl.useTls);
  };

  const handleSave = async () => {
    if (!fromAddress.trim()) {
      setLocalError('From email address is required');
      return;
    }

    setSaving(true);
    try {
      const body: UpdateEmailSettingsBody = {
        provider,
        enabled,
        fromAddress: fromAddress.trim(),
        fromName: fromName.trim() || undefined,
      };

      if (provider === 'ses') {
        body.sesRegion = sesRegion;
      } else {
        body.smtpHost = smtpHost.trim() || undefined;
        const portNum = Number(smtpPort);
        if (Number.isFinite(portNum) && portNum > 0) {
          body.smtpPort = portNum;
        }
        body.smtpUseTls = smtpUseTls;
        body.smtpUsername = smtpUsername.trim() || undefined;
        // Only send the password when the admin typed a new one.
        if (smtpPassword) {
          body.smtpPassword = smtpPassword;
        }
      }

      await saveSettings(body);
      setSuccessMessage('Email settings saved');
      setSmtpPassword('');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save email settings');
    } finally {
      setSaving(false);
    }
  };

  const openTestDialog = () => {
    setTestResult(null);
    setTestRecipient(fromAddress || '');
    setTestDialogOpen(true);
  };

  const handleSendTest = async () => {
    if (!testRecipient.trim()) {
      setTestResult({ ok: false, error: 'Recipient email is required' });
      return;
    }
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await sendTest(testRecipient.trim());
      setTestResult(result);
    } catch (err) {
      setTestResult({
        ok: false,
        error: err instanceof Error ? err.message : 'Test failed',
      });
    } finally {
      setTestLoading(false);
    }
  };

  if (loading && !settings) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !settings) {
    return (
      <Alert severity="error" sx={{ m: 3 }}>
        {error}
      </Alert>
    );
  }

  const isConfigured = !!settings?.provider;

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
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

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <EmailIcon color="primary" />
          <Typography variant="h4" component="h1">
            Email Settings
          </Typography>
        </Box>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Configure the outbound email provider (AWS SES or SMTP) and test delivery.
        </Typography>

        {/* Status chips */}
        <Stack direction="row" spacing={1} sx={{ mb: 3, flexWrap: 'wrap', gap: 1 }}>
          <Chip
            label={isConfigured ? 'Configured' : 'Not configured'}
            color={isConfigured ? 'primary' : 'default'}
            size="small"
            variant="outlined"
          />
          <Chip
            label={settings?.enabled ? 'Enabled' : 'Disabled'}
            color={settings?.enabled ? 'success' : 'default'}
            size="small"
            variant="outlined"
          />
          {settings?.credentialSource && (
            <Chip
              label={
                settings.credentialSource === 'ses:reuses-s3'
                  ? 'Credentials: reuses S3/AWS'
                  : 'Credentials: inline SMTP'
              }
              size="small"
              variant="outlined"
            />
          )}
        </Stack>

        {/* Provider selection */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Provider
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Choose how outbound email is delivered.
          </Typography>

          <ToggleButtonGroup
            color="primary"
            exclusive
            value={provider}
            onChange={(_e, val) => {
              if (val) setProvider(val as EmailProvider);
            }}
            size="small"
          >
            <ToggleButton value="ses">AWS SES</ToggleButton>
            <ToggleButton value="smtp">SMTP</ToggleButton>
          </ToggleButtonGroup>
        </Paper>

        {/* SES path */}
        {provider === 'ses' && (
          <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              AWS SES Configuration
            </Typography>

            <Alert severity="info" sx={{ mb: 2 }}>
              AWS SES will use the credentials configured in Storage Providers settings.
              No additional credentials needed.
            </Alert>

            {settings?.sesCredentialAvailable === false ? (
              <Alert severity="warning" sx={{ mb: 2 }}>
                No AWS credentials are currently configured. Set up an AWS S3 provider in{' '}
                <Link component={RouterLink} to="/admin/settings/storage/providers" underline="hover">
                  Storage Providers settings
                </Link>{' '}
                before enabling SES.
              </Alert>
            ) : (
              <Alert severity="success" icon={false} sx={{ py: 0.5, mb: 2 }}>
                The AWS credentials from Storage Providers will be reused for SES.
              </Alert>
            )}

            <FormControl size="small" fullWidth sx={{ mb: 1 }}>
              <InputLabel>AWS Region</InputLabel>
              <Select
                label="AWS Region"
                value={sesRegion}
                onChange={(e) => setSesRegion(e.target.value)}
              >
                {SES_REGIONS.map((r) => (
                  <MenuItem key={r.value} value={r.value}>
                    {r.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Paper>
        )}

        {/* SMTP path */}
        {provider === 'smtp' && (
          <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              SMTP Configuration
            </Typography>

            <FormControl size="small" fullWidth sx={{ mb: 2 }}>
              <InputLabel>Provider template</InputLabel>
              <Select
                label="Provider template"
                value={smtpTemplate}
                onChange={(e) => handleTemplateChange(e.target.value)}
              >
                {SMTP_TEMPLATES.map((t) => (
                  <MenuItem key={t.key} value={t.key}>
                    {t.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
              <TextField
                label="SMTP Host"
                size="small"
                fullWidth
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.example.com"
                sx={{ flex: 2 }}
              />
              <TextField
                label="Port"
                type="number"
                size="small"
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
                sx={{ flex: 1 }}
              />
            </Stack>

            <FormControlLabel
              control={
                <Switch
                  checked={smtpUseTls}
                  onChange={(e) => setSmtpUseTls(e.target.checked)}
                />
              }
              label="Use TLS/SSL"
              sx={{ mb: 2, display: 'block' }}
            />

            <TextField
              label="Username"
              size="small"
              fullWidth
              value={smtpUsername}
              onChange={(e) => setSmtpUsername(e.target.value)}
              sx={{ mb: 2 }}
            />

            {settings?.smtp.passwordConfigured && (
              <TextField
                label="Current Password"
                value={`••••••••${settings.smtp.passwordLast4 ?? ''}`}
                size="small"
                fullWidth
                disabled
                sx={{ mb: 2 }}
              />
            )}

            <TextField
              label="Password"
              type="password"
              size="small"
              fullWidth
              value={smtpPassword}
              onChange={(e) => setSmtpPassword(e.target.value)}
              placeholder={
                settings?.smtp.passwordConfigured
                  ? 'Leave blank to keep current password'
                  : 'Enter SMTP password'
              }
              sx={{ mb: 1 }}
            />
          </Paper>
        )}

        {/* Shared sender + enable */}
        <Paper variant="outlined" sx={{ p: 3, mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Sender & Status
          </Typography>

          <TextField
            label="From Email Address"
            type="email"
            size="small"
            fullWidth
            required
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            placeholder="no-reply@example.com"
            sx={{ mb: 2 }}
          />

          <TextField
            label="From Display Name"
            size="small"
            fullWidth
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            placeholder="MemoriaHub"
            sx={{ mb: 2 }}
          />

          <FormControlLabel
            control={
              <Switch
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
            }
            label="Enable outbound email"
            sx={{ mb: 2, display: 'block' }}
          />

          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              disabled={saving}
              startIcon={saving ? <CircularProgress size={16} /> : undefined}
              onClick={() => void handleSave()}
            >
              Save
            </Button>
            <Button
              variant="outlined"
              onClick={openTestDialog}
              disabled={!isConfigured}
            >
              Test connection
            </Button>
          </Stack>
        </Paper>
      </Box>

      {/* Test-connection dialog */}
      <Dialog
        open={testDialogOpen}
        onClose={() => {
          if (!testLoading) setTestDialogOpen(false);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Send a test email</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Enter a recipient address to verify the current email configuration.
          </Typography>
          <TextField
            label="Recipient email"
            type="email"
            size="small"
            fullWidth
            value={testRecipient}
            onChange={(e) => setTestRecipient(e.target.value)}
            placeholder="you@example.com"
            autoFocus
          />
          {testResult != null && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2 }}>
              {testResult.ok ? (
                <CheckCircleIcon color="success" fontSize="small" />
              ) : (
                <ErrorIcon color="error" fontSize="small" />
              )}
              <Typography
                variant="body2"
                color={testResult.ok ? 'success.main' : 'error.main'}
              >
                {testResult.ok
                  ? `Test email sent${testResult.messageId ? ` — message ID: ${testResult.messageId}` : ''}`
                  : (testResult.error ?? 'Test failed')}
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTestDialogOpen(false)} disabled={testLoading}>
            Close
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSendTest()}
            disabled={testLoading}
            startIcon={testLoading ? <CircularProgress size={16} /> : undefined}
          >
            Send test
          </Button>
        </DialogActions>
      </Dialog>

      {/* Success Snackbar */}
      <Snackbar
        open={!!successMessage}
        autoHideDuration={5000}
        onClose={() => setSuccessMessage(null)}
        message={successMessage}
      />

      {/* Error Snackbar */}
      <Snackbar
        open={!!localError}
        autoHideDuration={5000}
        onClose={() => setLocalError(null)}
      >
        <Alert severity="error" onClose={() => setLocalError(null)}>
          {localError}
        </Alert>
      </Snackbar>
    </Container>
  );
}

export default function EmailSettingsPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <EmailSettingsContent />;
}
