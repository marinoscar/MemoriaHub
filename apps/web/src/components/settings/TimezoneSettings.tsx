import { useEffect, useMemo, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  TextField,
  Typography,
} from '@mui/material';
import PublicIcon from '@mui/icons-material/Public';
import {
  detectTimeZone,
  formatNowInZone,
  listTimeZones,
} from '../../utils/timezone';

interface TimezoneSettingsProps {
  /**
   * The RAW stored zone. `null`/`undefined` means the user has never set one —
   * distinct from an explicit `'UTC'`, which is a real choice.
   */
  currentTimezone?: string | null;
  onTimezoneChange: (timezone: string) => void;
  disabled?: boolean;
}

/** How often the live sample re-renders "now". */
const SAMPLE_TICK_MS = 30_000;

/**
 * Per-user IANA time-zone picker (issue #444, epic #440).
 *
 * A plain single-select `Autocomplete` over `Intl.supportedValuesOf('timeZone')`
 * — deliberately un-virtualized. MUI's default `filterOptions` narrows ~400
 * entries after the first keystroke, and adding a virtualized listbox would
 * mean a new dependency and a bespoke `ListboxComponent` for a list this app
 * renders exactly once.
 */
export function TimezoneSettings({
  currentTimezone,
  onTimezoneChange,
  disabled = false,
}: TimezoneSettingsProps) {
  const detected = useMemo(() => detectTimeZone(), []);
  const value = currentTimezone ?? null;

  // Re-render the sample periodically so it reads as a clock rather than a
  // frozen string. Cheap: one setState every 30s while the page is open.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), SAMPLE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  /**
   * The runtime's zone list plus whatever is currently stored and whatever the
   * browser detected. A value the runtime doesn't enumerate (an older browser
   * on the fallback list, or a zone this build predates) must still be
   * selectable rather than silently vanishing from its own picker.
   */
  const options = useMemo(() => {
    const zones = new Set(listTimeZones());
    if (value) zones.add(value);
    if (detected) zones.add(detected);
    return [...zones].sort();
  }, [value, detected]);

  const showDetected = detected !== null && detected !== value;
  const sample = value ? formatNowInZone(value, now) : null;

  return (
    <Card id="timezone">
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Time zone
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          The time zone the app uses to interpret dates for you.
        </Typography>

        <Autocomplete<string>
          options={options}
          value={value}
          onChange={(_, next) => {
            if (next) onTimezoneChange(next);
          }}
          getOptionLabel={(opt) => opt}
          isOptionEqualToValue={(a, b) => a === b}
          disabled={disabled}
          size="small"
          fullWidth
          renderInput={(params) => (
            <TextField
              {...params}
              label="Time zone"
              size="small"
              placeholder="Search time zones"
            />
          )}
        />

        {showDetected && (
          <Box sx={{ mt: 1.5, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="body2" color="text.secondary">
              Detected: {detected}
            </Typography>
            <Button
              size="small"
              startIcon={<PublicIcon fontSize="small" />}
              disabled={disabled}
              onClick={() => onTimezoneChange(detected)}
            >
              Use detected time zone
            </Button>
          </Box>
        )}

        {sample && (
          <Typography variant="body2" sx={{ mt: 1.5 }}>
            It is currently <strong>{sample}</strong> in {value}.
          </Typography>
        )}

        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
          This decides when &ldquo;today&rdquo; starts for you — On This Day,
          date filters and anything else that groups your library by day.
          It does <strong>not</strong> change photo capture dates: a photo always
          shows the time it was actually taken, in the local time of wherever
          you took it.
        </Typography>
      </CardContent>
    </Card>
  );
}
