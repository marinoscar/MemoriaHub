/**
 * MapTimeFilter — time-range presets + custom date range for the map.
 *
 * Presets (3 Months / 12 Months / 3 Years / All) are computed client-side and
 * emitted upward as an ISO range; "All" clears the range. The "Custom" toggle
 * opens a Popover with native From/To date inputs. The emitted range feeds the
 * map's aggregate + drawer point fetches so filtering happens server-side.
 */

import { useCallback, useRef, useState } from 'react';
import {
  ToggleButton,
  ToggleButtonGroup,
  Popover,
  Box,
  TextField,
} from '@mui/material';

export interface MapTimeRange {
  from: string | null;
  to: string | null;
}

type PresetKey = '3m' | '12m' | '3y' | 'all' | 'custom';

interface MapTimeFilterProps {
  onChange: (range: MapTimeRange) => void;
}

/** Compute the `from` ISO timestamp for a relative preset (to = now/open). */
function presetRange(key: Exclude<PresetKey, 'all' | 'custom'>): MapTimeRange {
  const from = new Date();
  switch (key) {
    case '3m':
      from.setMonth(from.getMonth() - 3);
      break;
    case '12m':
      from.setFullYear(from.getFullYear() - 1);
      break;
    case '3y':
      from.setFullYear(from.getFullYear() - 3);
      break;
  }
  return { from: from.toISOString(), to: null };
}

/** Convert native `YYYY-MM-DD` inputs to an inclusive ISO day range. */
function customRange(fromStr: string, toStr: string): MapTimeRange {
  return {
    from: fromStr ? new Date(`${fromStr}T00:00:00`).toISOString() : null,
    to: toStr ? new Date(`${toStr}T23:59:59.999`).toISOString() : null,
  };
}

export function MapTimeFilter({ onChange }: MapTimeFilterProps) {
  const [preset, setPreset] = useState<PresetKey>('all');
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const customBtnRef = useRef<HTMLButtonElement>(null);

  const handlePreset = useCallback(
    (_e: React.MouseEvent<HTMLElement>, value: PresetKey | null) => {
      if (value === null) return; // ignore de-select; keep an exclusive choice

      setPreset(value);

      if (value === 'custom') {
        setAnchorEl(customBtnRef.current);
        onChange(customRange(customFrom, customTo));
        return;
      }
      if (value === 'all') {
        onChange({ from: null, to: null });
        return;
      }
      onChange(presetRange(value));
    },
    [customFrom, customTo, onChange],
  );

  const handleCustomFrom = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setCustomFrom(v);
      onChange(customRange(v, customTo));
    },
    [customTo, onChange],
  );

  const handleCustomTo = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setCustomTo(v);
      onChange(customRange(customFrom, v));
    },
    [customFrom, onChange],
  );

  return (
    <>
      <ToggleButtonGroup
        value={preset}
        exclusive
        onChange={handlePreset}
        size="small"
        aria-label="Filter map by time range"
      >
        <ToggleButton value="3m">3M</ToggleButton>
        <ToggleButton value="12m">12M</ToggleButton>
        <ToggleButton value="3y">3Y</ToggleButton>
        <ToggleButton value="all">All</ToggleButton>
        <ToggleButton value="custom" ref={customBtnRef}>
          Custom
        </ToggleButton>
      </ToggleButtonGroup>

      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, p: 2, width: 220 }}>
          <TextField
            label="From"
            type="date"
            size="small"
            fullWidth
            value={customFrom}
            onChange={handleCustomFrom}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            label="To"
            type="date"
            size="small"
            fullWidth
            value={customTo}
            onChange={handleCustomTo}
            slotProps={{ inputLabel: { shrink: true } }}
          />
        </Box>
      </Popover>
    </>
  );
}
