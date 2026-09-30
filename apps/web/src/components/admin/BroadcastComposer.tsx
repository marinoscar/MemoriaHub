/**
 * Compose an announcement for every active user. Epic #481, issue #488
 * (ported from the reference implementation).
 *
 * The only control in the application that reaches every user at once and
 * cannot be undone, so the dialog is built around three obligations:
 *
 *   1. **Show what will be sent.** A live preview of what the bell will render,
 *      paragraph splitting included (blank lines separate paragraphs).
 *   2. **Say how many people that is.** One plain-English line from
 *      `GET /audience`, in the composer and again in the confirmation.
 *   3. **Refuse what the API would refuse, before it is sent.** Every rule the
 *      create DTO enforces is mirrored as a disabled control or inline error:
 *        * title ≤ 120, body ≤ 2,000, link ≤ 500, CTA label ≤ 40 — counters,
 *          from `services/broadcasts.ts` so they cannot drift from the API;
 *        * the CTA label requires a link;
 *        * the link is root-relative (`/…`), never `//…` or `/\…`, no spaces;
 *        * `critical ⇒ channels includes 'inbox'` — the Important switch forces
 *          Inbox on and locks it, so the 400 is unreachable from this form;
 *        * `push ⇒ channels includes 'inbox'` (a push is dispatched from, and
 *          opens, the inbox row) — Push is disabled while Inbox is off, and
 *          clearing Inbox clears Push;
 *        * `scheduledFor` strictly in the future;
 *        * at least one channel.
 *
 * `pushEnabled === false` (never `!config?.pushEnabled`: `null` means "not
 * known yet") disables the Push channel — a deployment with web push off
 * would drop a channel the admin believed they had selected.
 */

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormLabel,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import {
  BROADCAST_BODY_MAX,
  BROADCAST_CHANNELS,
  BROADCAST_CTA_LABEL_MAX,
  BROADCAST_LINK_MAX,
  BROADCAST_TITLE_MAX,
  channelLabel,
  isoToLocalInput,
  localInputToIso,
} from '../../services/broadcasts';
import type {
  BroadcastChannel,
  BroadcastTestResult,
  CreateBroadcastRequest,
} from '../../services/broadcasts';
import { getNotificationClientConfig } from '../../services/pushDiagnostics';
import type { NotificationClientConfig } from '../../services/pushDiagnostics';

/** Default selection for a fresh composition: the durable inbox row. */
const DEFAULT_CHANNELS: BroadcastChannel[] = ['inbox'];

/** C0 controls, space and DEL — the API's forbidden link characters. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_LINK_CHARS = /[\u0000- \u007F]/;

/** The API's root-relative link rules, in the order they are reported. */
export function validateLink(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.length > BROADCAST_LINK_MAX) {
    return `Links are limited to ${BROADCAST_LINK_MAX} characters.`;
  }
  if (FORBIDDEN_LINK_CHARS.test(value)) {
    return 'Links must not contain spaces or control characters.';
  }
  if (!value.startsWith('/')) {
    return 'Links must point inside this application and start with "/" — for example /memories.';
  }
  if (value.startsWith('//')) {
    return 'A link starting with "//" is a link to another site. Use a single leading slash.';
  }
  if (value.startsWith('/\\')) {
    return 'A link starting with "/\\" is treated as another site by some browsers.';
  }
  return null;
}

/** `now + 1 minute`, as a `datetime-local` value, for the field's `min`. */
export function earliestSchedule(now: Date = new Date()): string {
  return isoToLocalInput(new Date(now.getTime() + 60_000).toISOString());
}

export interface BroadcastComposerProps {
  open: boolean;
  onClose: () => void;
  /** `null` until `GET /audience` resolves — never rendered as 0. */
  audience: number | null;
  isWorking: boolean;
  /** Resolves truthy when the broadcast was queued; the composer then closes. */
  onSubmit: (body: CreateBroadcastRequest) => Promise<boolean>;
  /** Resolves the result when the test send was dispatched, else `null`. Does NOT close. */
  onSendTest: (body: CreateBroadcastRequest) => Promise<BroadcastTestResult | null>;
}

export function BroadcastComposer({
  open,
  onClose,
  audience,
  isWorking,
  onSubmit,
  onSendTest,
}: BroadcastComposerProps) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  const [clientConfig, setClientConfig] = useState<NotificationClientConfig | null>(null);
  const pushUnavailable = clientConfig?.pushEnabled === false;

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [linkTouched, setLinkTouched] = useState(false);
  const [ctaLabel, setCtaLabel] = useState('');
  const [channels, setChannels] = useState<BroadcastChannel[]>(DEFAULT_CHANNELS);
  const [critical, setCritical] = useState(false);
  const [timing, setTiming] = useState<'now' | 'later'>('now');
  const [scheduleInput, setScheduleInput] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [testNotice, setTestNotice] = useState<{ severity: 'success' | 'warning'; text: string } | null>(
    null,
  );

  // Transient state resets on open; the draft itself survives a close, so a
  // composition interrupted by a 400 the admin had to go check is not lost.
  useEffect(() => {
    if (!open) return;
    setLinkTouched(false);
    setConfirming(false);
    setTestNotice(null);
    let canceled = false;
    getNotificationClientConfig()
      .then((config) => {
        if (!canceled) setClientConfig(config);
      })
      .catch(() => {
        // Unknown is not "off": leave every channel selectable.
        if (!canceled) setClientConfig(null);
      });
    return () => {
      canceled = true;
    };
  }, [open]);

  // critical ⇒ inbox, applied as STATE rather than as validation.
  useEffect(() => {
    if (!critical) return;
    setChannels((current) => (current.includes('inbox') ? current : [...current, 'inbox']));
  }, [critical]);

  useEffect(() => {
    if (!pushUnavailable) return;
    setChannels((current) => current.filter((channel) => channel !== 'push'));
  }, [pushUnavailable]);

  const linkError = linkTouched ? validateLink(link) : null;
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  const trimmedLink = link.trim();

  const minSchedule = useMemo(() => (open ? earliestSchedule() : ''), [open]);

  const scheduledIso = timing === 'later' ? localInputToIso(scheduleInput) : null;
  const scheduleInPast =
    timing === 'later' && scheduledIso !== null && new Date(scheduledIso).getTime() <= Date.now();
  const scheduleMissing = timing === 'later' && scheduledIso === null;

  const canSubmit =
    trimmedTitle.length > 0 &&
    trimmedTitle.length <= BROADCAST_TITLE_MAX &&
    trimmedBody.length > 0 &&
    trimmedBody.length <= BROADCAST_BODY_MAX &&
    channels.length > 0 &&
    validateLink(link) === null &&
    !scheduleMissing &&
    !scheduleInPast &&
    !isWorking;

  // Channels are sent in canonical order regardless of click order.
  const orderedChannels = BROADCAST_CHANNELS.filter((channel) => channels.includes(channel));

  const request: CreateBroadcastRequest = {
    title: trimmedTitle,
    body: trimmedBody,
    ...(trimmedLink ? { link: trimmedLink } : {}),
    ...(trimmedLink && ctaLabel.trim() ? { ctaLabel: ctaLabel.trim() } : {}),
    critical,
    channels: orderedChannels,
    ...(scheduledIso ? { scheduledFor: scheduledIso } : {}),
  };

  const toggleChannel = (channel: BroadcastChannel) => {
    setChannels((current) => {
      if (!current.includes(channel)) return [...current, channel];
      const next = current.filter((entry) => entry !== channel);
      // push ⇒ inbox: clearing Inbox also clears Push.
      return channel === 'inbox' ? next.filter((entry) => entry !== 'push') : next;
    });
  };

  const handleSendTest = async () => {
    setTestNotice(null);
    const result = await onSendTest(request);
    if (!result) return;
    if (result.email && !result.email.success) {
      setTestNotice({
        severity: 'warning',
        text:
          'Test sent to you only, but the email could not be delivered' +
          (result.email.error ? `: ${result.email.error}` : '.'),
      });
      return;
    }
    setTestNotice({ severity: 'success', text: 'Test sent to you only. Nobody else was contacted.' });
  };

  const handleConfirmedSubmit = async () => {
    setConfirming(false);
    const ok = await onSubmit(request);
    if (ok) onClose();
  };

  const paragraphs = trimmedBody.split(/\n{2,}/).filter((paragraph) => paragraph.length > 0);

  const channelPhrase = orderedChannels.map(channelLabel).join(' and ') || 'no channels';
  const audiencePhrase =
    audience === null
      ? 'Goes to all active users'
      : `Goes to all ${audience.toLocaleString()} active user${audience === 1 ? '' : 's'}`;

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        fullWidth
        maxWidth="md"
        fullScreen={isCompactWindow}
        aria-labelledby="broadcast-composer-title"
      >
        <DialogTitle id="broadcast-composer-title">New broadcast</DialogTitle>
        <DialogContent dividers>
          <Box
            component="form"
            id="broadcast-composer-form"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              if (canSubmit) setConfirming(true);
            }}
          >
            <Stack spacing={3}>
              {testNotice && (
                <Alert severity={testNotice.severity} onClose={() => setTestNotice(null)}>
                  {testNotice.text}
                </Alert>
              )}

              <TextField
                label="Title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                fullWidth
                slotProps={{ htmlInput: { maxLength: BROADCAST_TITLE_MAX } }}
                helperText={`${title.length} / ${BROADCAST_TITLE_MAX}`}
              />

              <TextField
                label="Body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                required
                fullWidth
                multiline
                minRows={5}
                slotProps={{ htmlInput: { maxLength: BROADCAST_BODY_MAX } }}
                helperText={`Blank lines separate paragraphs. Formatting is not supported. ${body.length} / ${BROADCAST_BODY_MAX}`}
              />

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField
                  label="Link (optional)"
                  value={link}
                  onChange={(event) => setLink(event.target.value)}
                  onBlur={() => setLinkTouched(true)}
                  fullWidth
                  placeholder="/memories"
                  error={linkError !== null}
                  helperText={
                    linkError ??
                    'A path inside this application, starting with "/". External links are not accepted.'
                  }
                />
                <Tooltip title={trimmedLink ? '' : 'A button label needs a link to point at.'}>
                  <Box component="span" sx={{ width: '100%' }}>
                    <TextField
                      label="Button label"
                      value={ctaLabel}
                      onChange={(event) => setCtaLabel(event.target.value)}
                      fullWidth
                      disabled={!trimmedLink}
                      slotProps={{ htmlInput: { maxLength: BROADCAST_CTA_LABEL_MAX } }}
                      helperText={`${ctaLabel.length} / ${BROADCAST_CTA_LABEL_MAX}`}
                    />
                  </Box>
                </Tooltip>
              </Stack>

              <Divider />

              <FormControl component="fieldset" variant="standard">
                <FormLabel component="legend">Channels</FormLabel>
                <FormGroup row>
                  {BROADCAST_CHANNELS.map((channel) => {
                    const isPush = channel === 'push';
                    const lockedByCritical = channel === 'inbox' && critical;
                    const pushNeedsInbox = isPush && !channels.includes('inbox');
                    const disabled = (isPush && pushUnavailable) || pushNeedsInbox || lockedByCritical;
                    const tooltip =
                      isPush && pushUnavailable
                        ? 'Web push is not enabled on this deployment, so there is no push channel to send over.'
                        : pushNeedsInbox
                          ? 'A push notification opens the inbox notification, so select Inbox first.'
                          : lockedByCritical
                            ? 'An important announcement must leave an inbox record, so this cannot be turned off.'
                            : '';

                    return (
                      <Tooltip key={channel} title={tooltip}>
                        <span>
                          <FormControlLabel
                            control={
                              <Checkbox
                                checked={channels.includes(channel)}
                                onChange={() => toggleChannel(channel)}
                                disabled={disabled}
                              />
                            }
                            label={channelLabel(channel)}
                          />
                        </span>
                      </Tooltip>
                    );
                  })}
                </FormGroup>
                {channels.length === 0 && (
                  <Typography variant="caption" color="error">
                    Select at least one channel — a broadcast with none reaches nobody.
                  </Typography>
                )}
                {channels.includes('email') && (
                  <Typography variant="caption" color="text.secondary">
                    Email is sent only when an email provider is configured and enabled.
                  </Typography>
                )}
              </FormControl>

              <FormControlLabel
                control={
                  <Switch checked={critical} onChange={(event) => setCritical(event.target.checked)} />
                }
                label="Important — recipients cannot mute this"
              />
              {critical && (
                <Typography variant="caption" color="text.secondary">
                  Delivered to every inbox regardless of each recipient&apos;s notification
                  preferences and of the admin notification-type switches. Inbox is forced on so
                  there is a record everyone can go back and read. Reserve this for security and
                  service announcements.
                </Typography>
              )}

              <Divider />

              <FormControl>
                <FormLabel id="broadcast-timing-label">When to send</FormLabel>
                <RadioGroup
                  aria-labelledby="broadcast-timing-label"
                  value={timing}
                  onChange={(event) => setTiming(event.target.value as 'now' | 'later')}
                >
                  <FormControlLabel value="now" control={<Radio />} label="Send now" />
                  <FormControlLabel value="later" control={<Radio />} label="Schedule for later" />
                </RadioGroup>
              </FormControl>

              {timing === 'later' && (
                <Box>
                  <TextField
                    label="Send at"
                    type="datetime-local"
                    value={scheduleInput}
                    onChange={(event) => setScheduleInput(event.target.value)}
                    slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: minSchedule } }}
                    error={scheduleInPast}
                    helperText={
                      scheduleInPast ? 'Pick a time in the future.' : 'Your local time.'
                    }
                  />
                  {scheduledIso && !scheduleInPast && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                      Sends at {new Date(scheduledIso).toLocaleString()} in your time zone —{' '}
                      {new Date(scheduledIso).toISOString()} UTC.
                    </Typography>
                  )}
                </Box>
              )}

              <Divider />

              <Box>
                <Typography variant="overline" color="text.secondary">
                  Preview
                </Typography>
                <Paper variant="outlined" sx={{ p: 2, mt: 0.5 }} data-testid="broadcast-preview">
                  <Stack direction="row" spacing={1.5}>
                    <CampaignOutlinedIcon color={critical ? 'error' : 'action'} />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>
                        {trimmedTitle || 'Your title appears here'}
                      </Typography>
                      {paragraphs.length === 0 ? (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                          Your message appears here.
                        </Typography>
                      ) : (
                        paragraphs.map((paragraph, index) => (
                          <Typography
                            key={index}
                            variant="body2"
                            sx={{ mt: 0.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                          >
                            {paragraph}
                          </Typography>
                        ))
                      )}
                      {trimmedLink && (
                        <Button size="small" sx={{ mt: 1 }} disabled>
                          {ctaLabel.trim() || 'View'}
                        </Button>
                      )}
                    </Box>
                  </Stack>
                </Paper>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  {audiencePhrase} over {channelPhrase}.
                </Typography>
              </Box>
            </Stack>
          </Box>
        </DialogContent>

        <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Tooltip
            title={
              canSubmit
                ? 'Sends this exact composition to you alone. Nothing is stored and nobody else is contacted.'
                : 'Fill in the title, the body and at least one channel first.'
            }
          >
            <span>
              <Button onClick={() => void handleSendTest()} disabled={!canSubmit}>
                Send test to me
              </Button>
            </span>
          </Tooltip>
          <Box sx={{ flexGrow: 1 }} />
          <Button onClick={onClose} disabled={isWorking}>
            Cancel
          </Button>
          <span>
            <Button type="submit" form="broadcast-composer-form" variant="contained" disabled={!canSubmit}>
              {timing === 'later' ? 'Schedule…' : 'Send…'}
            </Button>
          </span>
        </DialogActions>
      </Dialog>

      <Dialog open={confirming} onClose={() => setConfirming(false)}>
        <DialogTitle>{timing === 'later' ? 'Schedule this broadcast?' : 'Send this to everyone?'}</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            <Typography variant="body2" gutterBottom>
              <strong>{trimmedTitle}</strong>
            </Typography>
            <Typography variant="body2" gutterBottom>
              {audience === null
                ? 'This goes to every active user'
                : `This goes to all ${audience.toLocaleString()} active user${audience === 1 ? '' : 's'}`}{' '}
              over {channelPhrase}.
            </Typography>
            <Typography variant="body2" gutterBottom>
              {critical
                ? 'Marked important: it reaches every inbox, bypassing notification preferences.'
                : 'Normal importance: recipients who have switched announcements off will not receive it.'}
            </Typography>
            <Typography variant="body2" gutterBottom>
              {scheduledIso
                ? `It will be sent at ${new Date(scheduledIso).toLocaleString()} (${new Date(scheduledIso).toISOString()} UTC). You can cancel it until then.`
                : 'It will start sending immediately.'}
            </Typography>
            <Typography variant="body2">
              A broadcast cannot be edited or recalled once it has been sent.
            </Typography>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirming(false)}>Back</Button>
          <Button variant="contained" onClick={() => void handleConfirmedSubmit()} disabled={isWorking}>
            {timing === 'later' ? 'Schedule broadcast' : 'Send broadcast'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export default BroadcastComposer;
