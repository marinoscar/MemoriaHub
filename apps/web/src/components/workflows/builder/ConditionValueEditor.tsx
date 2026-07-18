import { useEffect, useState } from 'react';
import {
  TextField,
  Box,
  Autocomplete,
  Chip,
  ToggleButtonGroup,
  ToggleButton,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Slider,
  Typography,
} from '@mui/material';
import { PersonMultiSelect } from '../../search/PersonMultiSelect';
import { LocationPickerMap } from '../../media/LocationPickerMap';
import { getExploreTags, listAlbums } from '../../../services/media';
import type { ExploreItem } from '../../../services/media';
import type { Album } from '../../../types/media';
import type {
  WorkflowFieldDescriptor,
  WorkflowOperator,
} from '../../../types/workflows';

interface ConditionValueEditorProps {
  circleId: string;
  field: WorkflowFieldDescriptor;
  op: WorkflowOperator;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Tag vocabulary + albums are loaded once by the parent block and passed down. */
  tags: ExploreItem[];
  albums: Album[];
}

interface DateRange {
  from?: string;
  to?: string;
}

interface GeoRadius {
  lat: number;
  lng: number;
  radiusKm: number;
}

interface PersonSet {
  ids: string[];
  mode: 'all' | 'any';
}

// ---------------------------------------------------------------------------
// ConditionValueEditor — renders the right value control for a field+operator,
// reusing the deterministic-search editors (tag autocomplete, PersonMultiSelect
// people picker, LocationPickerMap map-radius picker, date inputs).
//
// Operator matters, not just field.valueType: date fields switch between a
// range (between), a single date (before/after), and a day-count (relative).
// ---------------------------------------------------------------------------

export function ConditionValueEditor({
  circleId,
  field,
  op,
  value,
  onChange,
  tags,
  albums,
}: ConditionValueEditorProps) {
  // is_set (and any no-value operator) needs no editor.
  if (op === 'is_set') return null;

  // ---- Date family (operator-driven) --------------------------------------
  if (field.valueType === 'date-range' || field.type === 'date') {
    if (op === 'older_than_days' || op === 'within_last_days') {
      return (
        <TextField
          label="Days"
          type="number"
          size="small"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          sx={{ minWidth: 140 }}
          slotProps={{ htmlInput: { min: 1 } }}
        />
      );
    }
    if (op === 'before' || op === 'after') {
      return (
        <TextField
          label="Date"
          type="date"
          size="small"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ minWidth: 180 }}
        />
      );
    }
    // between → { from, to }
    const range = (value ?? {}) as DateRange;
    return (
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <TextField
          label="From"
          type="date"
          size="small"
          value={range.from ?? ''}
          onChange={(e) =>
            onChange({ ...range, from: e.target.value || undefined })
          }
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ minWidth: 160 }}
        />
        <TextField
          label="To"
          type="date"
          size="small"
          value={range.to ?? ''}
          onChange={(e) => onChange({ ...range, to: e.target.value || undefined })}
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ minWidth: 160 }}
        />
      </Box>
    );
  }

  // ---- Boolean (op 'is') ---------------------------------------------------
  if (field.valueType === 'boolean') {
    const bool = value === true;
    return (
      <ToggleButtonGroup
        exclusive
        size="small"
        value={bool ? 'true' : 'false'}
        onChange={(_, v) => {
          if (v !== null) onChange(v === 'true');
        }}
      >
        <ToggleButton value="true">Yes</ToggleButton>
        <ToggleButton value="false">No</ToggleButton>
      </ToggleButtonGroup>
    );
  }

  // ---- Enum ----------------------------------------------------------------
  if (field.valueType === 'enum') {
    return (
      <FormControl size="small" sx={{ minWidth: 180 }}>
        <InputLabel>Value</InputLabel>
        <Select
          label="Value"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          {(field.enumValues ?? []).map((ev) => (
            <MenuItem key={ev} value={ev}>
              {ev}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    );
  }

  // ---- Number / positive-int ----------------------------------------------
  if (field.valueType === 'number' || field.valueType === 'positive-int') {
    return (
      <TextField
        label="Value"
        type="number"
        size="small"
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        sx={{ minWidth: 160 }}
      />
    );
  }

  // ---- Tag set (string-list) ----------------------------------------------
  if (field.valueType === 'string-list') {
    const list = Array.isArray(value) ? (value as string[]) : [];
    return (
      <Autocomplete<string, true, false, true>
        multiple
        freeSolo
        options={tags.map((t) => t.name)}
        value={list}
        onChange={(_, v) => onChange(v)}
        renderValue={(vals, getItemProps) =>
          (vals as string[]).map((option, index) => {
            const { key, ...chipProps } = getItemProps({ index });
            return <Chip key={key} {...chipProps} label={option} size="small" />;
          })
        }
        renderInput={(params) => (
          <TextField {...params} label="Tags" size="small" placeholder="Add tag" />
        )}
        sx={{ minWidth: 240, flex: 1 }}
      />
    );
  }

  // ---- Person set ----------------------------------------------------------
  if (field.valueType === 'person-set') {
    const pv = (value ?? { ids: [], mode: 'any' }) as PersonSet;
    return (
      <Box sx={{ flex: 1, minWidth: 260 }}>
        <PersonMultiSelect
          circleId={circleId}
          value={pv}
          onChange={(next) => onChange(next)}
          label="People"
        />
      </Box>
    );
  }

  // ---- Geo radius ----------------------------------------------------------
  if (field.valueType === 'geo-radius') {
    const geo = (value ?? null) as GeoRadius | null;
    const pin = geo ? { lat: geo.lat, lng: geo.lng } : null;
    const radiusKm = geo?.radiusKm ?? 25;
    return (
      <Box sx={{ width: '100%' }}>
        <LocationPickerMap
          value={pin}
          onChange={(latlng) => onChange({ ...latlng, radiusKm })}
          height={220}
        />
        <Typography variant="body2" sx={{ mt: 1 }}>
          Radius: {radiusKm} km
        </Typography>
        <Slider
          value={radiusKm}
          onChange={(_, v) => {
            const r = Array.isArray(v) ? v[0] : v;
            onChange({ lat: pin?.lat ?? 0, lng: pin?.lng ?? 0, radiusKm: r });
          }}
          disabled={!pin}
          min={1}
          max={200}
          step={5}
          valueLabelDisplay="auto"
        />
      </Box>
    );
  }

  // ---- Album (uuid) --------------------------------------------------------
  if (field.valueType === 'uuid') {
    return (
      <FormControl size="small" sx={{ minWidth: 220 }}>
        <InputLabel>Album</InputLabel>
        <Select
          label="Album"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          {albums.map((a) => (
            <MenuItem key={a.id} value={a.id}>
              {a.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    );
  }

  // ---- String (default) ----------------------------------------------------
  return (
    <TextField
      label="Value"
      size="small"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      sx={{ minWidth: 200, flex: 1 }}
    />
  );
}

// ---------------------------------------------------------------------------
// Small hook: load the circle's tag vocabulary + albums once for the whole
// Conditions block (and reused by the Actions block). Exported for reuse.
// ---------------------------------------------------------------------------

export function useConditionEditorData(circleId: string | null): {
  tags: ExploreItem[];
  albums: Album[];
} {
  const [tags, setTags] = useState<ExploreItem[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);

  useEffect(() => {
    if (!circleId) return;
    let active = true;
    void getExploreTags(circleId)
      .then((data) => active && setTags(data))
      .catch(() => active && setTags([]));
    void listAlbums({ circleId, pageSize: 200, sortBy: 'name', sortOrder: 'asc' })
      .then((resp) => active && setAlbums(resp.items))
      .catch(() => active && setAlbums([]));
    return () => {
      active = false;
    };
  }, [circleId]);

  return { tags, albums };
}
