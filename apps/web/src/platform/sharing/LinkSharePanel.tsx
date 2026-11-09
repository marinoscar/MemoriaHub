/**
 * Inline public-link controls for a photo or video (RETRO-I4, #578), over the sharing slice's
 * `useLinkGrants`: create a link (with an expiry, "Never" included), copy it, revoke it.
 *
 * Rendered as a plain DOM node, never a Modal: the media drawer and the lightbox are themselves
 * modals, and a portaled dialog opened over a temporary drawer freezes in a nested focus trap
 * (the reason the pre-platform `SharePanel` existed). Standalone surfaces use `MediaShareDialog`.
 */
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { useLinkGrants } from '@marinoscar/platform-web/sharing/headless';

import { LINK_EXPIRY_PRESETS, MEDIA_LINK_ROLES, type MediaShareType } from './shareOptions';

export interface LinkSharePanelProps {
  target: { type: MediaShareType; id: string };
}

/** `expiresAt` of a preset: `null` (never) or now plus the days. */
export function presetExpiry(days: number | null, now: Date = new Date()): string | null {
  if (days === null) return null;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return 'Never expires';
  return `Expires ${new Date(expiresAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

export function LinkSharePanel({ target }: LinkSharePanelProps) {
  const links = useLinkGrants({ type: target.type, id: target.id });
  const [preset, setPreset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const now = Date.now();
  const active = (links.data ?? []).filter((link) => !link.revokedAt && (!link.expiresAt || Date.parse(link.expiresAt) > now));

  const create = async () => {
    setError(null);
    try {
      await links.create({ role: MEDIA_LINK_ROLES[0]!.value, expiresAt: presetExpiry(LINK_EXPIRY_PRESETS[preset]!.days) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create the link');
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await links.revoke(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke the link');
    }
  };

  const copy = async (id: string, url: string) => {
    if (await links.copyUrl(url)) setCopied(id);
  };

  return (
    <Box>
      {(error || links.error) && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error ?? links.error?.message}
        </Alert>
      )}
      <Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">
          Anyone with the link can view. No metadata is shown and downloading is disabled.
        </Typography>

        {links.loading && links.data === null ? (
          <CircularProgress size={24} aria-label="Loading links" />
        ) : (
          active.map((link) => (
            <Box key={link.id}>
              <TextField
                label="Public link"
                value={link.url ?? ''}
                size="small"
                fullWidth
                slotProps={{
                  input: {
                    readOnly: true,
                    endAdornment: (
                      <InputAdornment position="end">
                        {link.url && (
                          <Tooltip title={copied === link.id ? 'Copied' : 'Copy link'}>
                            <IconButton edge="end" size="small" aria-label="Copy link" onClick={() => void copy(link.id, link.url!)}>
                              <ContentCopyIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                        <Tooltip title="Revoke link">
                          <IconButton
                            edge="end"
                            size="small"
                            aria-label="Revoke link"
                            disabled={links.pending}
                            onClick={() => void revoke(link.id)}
                          >
                            <LinkOffIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </InputAdornment>
                    ),
                  },
                }}
              />
              <Typography variant="caption" color="text.secondary">
                {formatExpiry(link.expiresAt)}
              </Typography>
            </Box>
          ))
        )}

        {active.length === 0 && (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
            <FormControl size="small" fullWidth>
              <InputLabel id={`link-expiry-${target.id}`}>Expires</InputLabel>
              <Select
                labelId={`link-expiry-${target.id}`}
                label="Expires"
                value={preset}
                onChange={(event) => setPreset(Number(event.target.value))}
                disabled={links.pending}
              >
                {LINK_EXPIRY_PRESETS.map((option, index) => (
                  <MenuItem key={option.label} value={index}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button variant="contained" onClick={() => void create()} disabled={links.pending} sx={{ flexShrink: 0 }}>
              Create link
            </Button>
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
