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
  Typography,
  Stack,
  Checkbox,
  FormControlLabel,
} from '@mui/material';
import { LocationPickerMap } from '../../../../media/ui/index.js';
import { WorkflowPersonSelect } from '../../../../people/ui/index.js';
import { useOwnerScope } from '../../../../core/headless/index.js';
import type { ExploreItem } from '../../../../media/headless/index.js';
import type { Album } from '../../../../media/headless/index.js';
import type { WorkflowActionInstance } from '../../../headless/types.js';
import { paramKindFor, RERUN_KINDS } from '../../../headless/constants/workflowActionMeta.js';

/**
 * Action Param Editor Props.
 *
 * @stability experimental
 */
export interface ActionParamEditorProps {
  /** The `circleId`. */
  circleId: string;
  /** The `action`. */
  action: WorkflowActionInstance;
  /** The `onChange`. */
  onChange: (action: WorkflowActionInstance) => void;
  /** The `tags`. */
  tags: ExploreItem[];
  /** The `albums`. */
  albums: Album[];
}

// ---------------------------------------------------------------------------
// ActionParamEditor — the per-action parameter form. Params are top-level
// siblings of `type` (never nested under a `params` key).
// ---------------------------------------------------------------------------

/**
 * Action Param Editor.
 *
 * @stability experimental
 */
export function ActionParamEditor({
  circleId,
  action,
  onChange,
  tags,
  albums,
}: ActionParamEditorProps) {
  const kind = paramKindFor(action.type);
  const set = (patch: Record<string, unknown>) => onChange({ ...action, ...patch });
  const replace = (next: WorkflowActionInstance) => onChange(next);

  // RETRO-I6 (#588): the destination libraries are the owner scopes ("My library" and the
  // caller's groups) where the caller may write; the API re-checks editor on BOTH scopes.
  const { scopes } = useOwnerScope();
  const writableScopes = scopes.filter((s) => s.role === 'editor' || s.role === 'admin');

  switch (kind) {
    case 'none':
      return null;

    // --- add_to_album: pick existing OR create-new -------------------------
    case 'album': {
      const albumId = typeof action.albumId === 'string' ? action.albumId : '';
      const createNamed =
        typeof action.createAlbumNamed === 'string' ? action.createAlbumNamed : '';
      const selectValue = createNamed ? '__new__' : albumId;
      return (
        <>
          <FormControl size="small" sx={{ minWidth: 240 }}>
            <InputLabel>Album</InputLabel>
            <Select
              label="Album"
              value={selectValue}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__new__') {
                  replace({ type: action.type, createAlbumNamed: '' });
                } else {
                  replace({ type: action.type, albumId: v });
                }
              }}
            >
              {albums.map((a) => (
                <MenuItem key={a.id} value={a.id}>
                  {a.name}
                </MenuItem>
              ))}
              <MenuItem value="__new__">
                <em>+ Create new album…</em>
              </MenuItem>
            </Select>
          </FormControl>
          {selectValue === '__new__' && (
            <TextField
              label="New album name"
              size="small"
              helperText="A new album with this name is created when the workflow runs"
              value={createNamed}
              onChange={(e) =>
                replace({ type: action.type, createAlbumNamed: e.target.value })
              }
              sx={{ minWidth: 240 }}
            />
          )}
        </>
      );
    }

    // --- remove_from_album -------------------------------------------------
    case 'albumId': {
      const albumId = typeof action.albumId === 'string' ? action.albumId : '';
      return (
        <FormControl size="small" sx={{ minWidth: 240 }}>
          <InputLabel>Album</InputLabel>
          <Select
            label="Album"
            value={albumId}
            onChange={(e) => set({ albumId: e.target.value })}
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

    // --- add_tags / remove_tags -------------------------------------------
    case 'tags': {
      const names = Array.isArray(action.names) ? (action.names as string[]) : [];
      return (
        <Autocomplete<string, true, false, true>
          multiple
          freeSolo
          options={tags.map((t) => t.name)}
          value={names}
          onChange={(_, v) => set({ names: v })}
          renderValue={(vals, getItemProps) =>
            (vals as string[]).map((option, index) => {
              const { key, ...chipProps } = getItemProps({ index });
              return <Chip key={key} {...chipProps} label={option} size="small" />;
            })
          }
          renderInput={(params) => (
            <TextField {...params} label="Tags" size="small" placeholder="Add tag" />
          )}
          sx={{ minWidth: 260, flex: 1 }}
        />
      );
    }

    // --- set_favorite ------------------------------------------------------
    case 'favorite': {
      const val = action.value === true;
      return (
        <ToggleButtonGroup
          exclusive
          size="small"
          value={val ? 'true' : 'false'}
          onChange={(_, v) => {
            if (v !== null) set({ value: v === 'true' });
          }}
        >
          <ToggleButton value="true">Favorite</ToggleButton>
          <ToggleButton value="false">Not favorite</ToggleButton>
        </ToggleButtonGroup>
      );
    }

    // --- set_captured_at (set | shift | clear) -----------------------------
    case 'capturedAt': {
      const mode = (action.mode as string) || 'set';
      return (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ flex: 1 }}>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>Mode</InputLabel>
            <Select
              label="Mode"
              value={mode}
              onChange={(e) => replace({ type: action.type, mode: e.target.value })}
            >
              <MenuItem value="set">Set to date</MenuItem>
              <MenuItem value="shift">Shift by minutes</MenuItem>
              <MenuItem value="clear">Clear date</MenuItem>
            </Select>
          </FormControl>
          {mode === 'set' && (
            <TextField
              label="Date &amp; time"
              type="datetime-local"
              size="small"
              value={typeof action.value === 'string' ? isoToLocal(action.value) : ''}
              onChange={(e) =>
                set({ value: e.target.value ? localToIso(e.target.value) : undefined })
              }
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ minWidth: 220 }}
            />
          )}
          {mode === 'shift' && (
            <TextField
              label="Shift (minutes, may be negative)"
              type="number"
              size="small"
              value={typeof action.shiftMinutes === 'number' ? action.shiftMinutes : ''}
              onChange={(e) =>
                set({
                  shiftMinutes: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
              sx={{ minWidth: 240 }}
            />
          )}
        </Stack>
      );
    }

    // --- assign_person / remove_person ------------------------------------
    case 'person': {
      return (
        <WorkflowPersonSelect
          circleId={circleId}
          value={typeof action.personId === 'string' ? action.personId : undefined}
          onChange={(personId) => set({ personId })}
        />
      );
    }

    // --- set_location ------------------------------------------------------
    case 'location': {
      const lat = typeof action.lat === 'number' ? action.lat : undefined;
      const lng = typeof action.lng === 'number' ? action.lng : undefined;
      const pin = lat !== undefined && lng !== undefined ? { lat, lng } : null;
      return (
        <Box sx={{ width: '100%' }}>
          <LocationPickerMap
            value={pin}
            onChange={(latlng) => set({ lat: latlng.lat, lng: latlng.lng })}
            height={220}
            // A workflow action param must only change on a deliberate pin
            // placement; wheel-zoom would hijack the builder's scrolling; and
            // the placeholder pin would read as an already-chosen location for
            // a param that is still unset. This surface stays visually and
            // behaviourally unchanged (issue #376).
            geolocateSetsValue={false}
            scrollWheelZoom={false}
            showPlaceholderMarker={false}
          />
          {pin && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
            </Typography>
          )}
        </Box>
      );
    }

    // --- move_to_owner -----------------------------------------------------
    case 'owner': {
      const target = action.target as { kind?: string; groupId?: string } | undefined;
      const value =
        target?.kind === 'group' && typeof target.groupId === 'string'
          ? `group:${target.groupId}`
          : target?.kind === 'me'
            ? 'me'
            : '';
      return (
        <FormControl size="small" sx={{ minWidth: 240 }}>
          <InputLabel>Destination library</InputLabel>
          <Select
            label="Destination library"
            value={value}
            onChange={(e) => {
              const v = String(e.target.value);
              set({ target: v === 'me' ? { kind: 'me' } : { kind: 'group', groupId: v.slice('group:'.length) } });
            }}
          >
            {writableScopes
              .filter((s) => s.id !== circleId)
              .map((s) => (
                <MenuItem key={s.id} value={s.kind === 'me' ? 'me' : `group:${s.id}`}>
                  {s.name}
                </MenuItem>
              ))}
          </Select>
        </FormControl>
      );
    }

    // --- move_to_circle (deprecated alias, existing actions only) ---------
    case 'circle': {
      const targetCircleId =
        typeof action.targetCircleId === 'string' ? action.targetCircleId : '';
      return (
        <FormControl size="small" sx={{ minWidth: 240 }}>
          <InputLabel>Destination circle</InputLabel>
          <Select
            label="Destination circle"
            value={targetCircleId}
            onChange={(e) => set({ targetCircleId: e.target.value })}
          >
            {writableScopes
              .filter((c) => c.id !== circleId)
              .map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.name}
                </MenuItem>
              ))}
          </Select>
        </FormControl>
      );
    }

    // --- rerun_enrichment --------------------------------------------------
    case 'rerunKinds': {
      const kinds = Array.isArray(action.kinds) ? (action.kinds as string[]) : [];
      const toggle = (k: string) => {
        const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
        set({ kinds: next });
      };
      return (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {RERUN_KINDS.map((k) => (
            <FormControlLabel
              key={k}
              control={
                <Checkbox size="small" checked={kinds.includes(k)} onChange={() => toggle(k)} />
              }
              label={k}
            />
          ))}
        </Box>
      );
    }

    // --- resolve_(burst|duplicate)_group -----------------------------------
    case 'resolveAction': {
      const resolveAction = (action.action as string) || 'trash';
      return (
        <ToggleButtonGroup
          exclusive
          size="small"
          value={resolveAction}
          onChange={(_, v) => {
            if (v !== null) set({ action: v });
          }}
          // Longest labels of any toggle group in the app; the group root is
          // inline-flex/nowrap, so it overflows the builder panel without this.
          sx={{ flexWrap: 'wrap' }}
        >
          <ToggleButton value="archive">Keep best, archive rest</ToggleButton>
          <ToggleButton value="trash">Keep best, trash rest</ToggleButton>
        </ToggleButtonGroup>
      );
    }

    default:
      return null;
  }
}

// datetime-local <-> ISO 8601 helpers -----------------------------------------
function isoToLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToIso(local: string): string {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? local : d.toISOString();
}
