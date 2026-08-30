import type { ComponentType } from 'react';
import {
  Box,
  ButtonBase,
  Chip,
  Collapse,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import HealingIcon from '@mui/icons-material/Healing';
import NightlightIcon from '@mui/icons-material/Nightlight';
import PaletteIcon from '@mui/icons-material/Palette';
import FaceRetouchingNaturalIcon from '@mui/icons-material/FaceRetouchingNatural';
import TuneIcon from '@mui/icons-material/Tune';
import type { SvgIconProps } from '@mui/material';
import type {
  EnhanceParams,
  EnhancePreset,
  EnhanceQuality,
  EnhanceStrength,
} from '../../services/enhance';

/**
 * Shared AI-Enhance parameter vocabulary — presets, the customize panel, and
 * the params mapping — consumed by BOTH the single-item MediaEnhancementDrawer
 * and the multi-select BatchEnhanceDialog (issue #422).
 *
 * This module exists so those two surfaces cannot drift: a preset whose prefill
 * differs between "enhance this photo" and "enhance these twelve photos" would
 * silently produce different prompts for the same user intent, and the
 * `intent: 'custom'`-only-when-genuinely-customized rule below is subtle enough
 * that a copy-paste would eventually get it wrong.
 */

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

export interface AdjustmentsState {
  color: boolean;
  tone: boolean;
  sharpness: boolean;
  denoise: boolean;
  dehaze: boolean;
  straighten: boolean;
}

export const ADJUSTMENT_FIELDS: { key: keyof AdjustmentsState; label: string }[] = [
  { key: 'color', label: 'Correct color & white balance' },
  { key: 'tone', label: 'Balance exposure & tone' },
  { key: 'sharpness', label: 'Increase clarity & sharpness' },
  { key: 'denoise', label: 'Reduce noise' },
  { key: 'dehaze', label: 'Remove haze' },
  { key: 'straighten', label: 'Straighten horizon' },
];

/** Mirrors the server-side defaults in `enhance-prompt.builder.ts`. */
export const DEFAULT_ADJUSTMENTS: AdjustmentsState = {
  color: true,
  tone: true,
  sharpness: true,
  denoise: true,
  dehaze: false,
  straighten: false,
};

export function adjustmentsEqual(a: AdjustmentsState, b: AdjustmentsState): boolean {
  return (ADJUSTMENT_FIELDS as { key: keyof AdjustmentsState }[]).every(
    ({ key }) => a[key] === b[key],
  );
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * `auto` and `custom` are UI-only choices — neither sends a `preset` to the
 * API. The four real values map 1:1 onto the server's preset enum.
 */
export type PresetKey = 'auto' | EnhancePreset | 'custom';

export interface PresetDef {
  key: PresetKey;
  label: string;
  description: string;
  Icon: ComponentType<SvgIconProps>;
  /** Shown as a warning chip for presets whose output is an AI invention. */
  interpretive?: boolean;
  /** Prefill applied when the preset is picked; every field stays editable. */
  prefill: {
    adjustments: AdjustmentsState;
    strength: EnhanceStrength;
    preserveFaces: boolean;
  };
}

export const PRESETS: PresetDef[] = [
  {
    key: 'auto',
    label: 'Auto',
    description: 'Balanced all-round improvement',
    Icon: AutoAwesomeIcon,
    prefill: {
      adjustments: DEFAULT_ADJUSTMENTS,
      strength: 'balanced',
      preserveFaces: true,
    },
  },
  {
    key: 'restore_old_photo',
    label: 'Restore old photo',
    description: 'Repair scratches, fading and creases in scans of old prints',
    Icon: HealingIcon,
    // Issue #436: this preset is aimed at damaged FACES essentially every time
    // it is used, and "strongly ... increase clarity and sharpness" was being
    // applied to the face just as much as to the creases — inviting the model
    // to re-detail (i.e. invent) features it has too few pixels to preserve.
    // dehaze/tone/denoise stay on: those act on the paper, not the face.
    // Both knobs remain raisable by hand under Customize.
    prefill: {
      adjustments: { ...DEFAULT_ADJUSTMENTS, tone: true, sharpness: false, denoise: true, dehaze: true },
      strength: 'balanced',
      preserveFaces: true,
    },
  },
  {
    key: 'low_light',
    label: 'Low-light rescue',
    description: 'Brighten dim indoor and night photos without washing them out',
    Icon: NightlightIcon,
    prefill: {
      adjustments: { ...DEFAULT_ADJUSTMENTS, tone: true, denoise: true },
      strength: 'strong',
      preserveFaces: true,
    },
  },
  {
    key: 'colorize_bw',
    label: 'Colorize B&W',
    description: 'Add natural color to a black-and-white photo',
    Icon: PaletteIcon,
    interpretive: true,
    prefill: {
      adjustments: DEFAULT_ADJUSTMENTS,
      strength: 'balanced',
      preserveFaces: true,
    },
  },
  {
    key: 'portrait_polish',
    label: 'Portrait polish',
    description: 'Even out skin tone and lighting on faces, gently',
    Icon: FaceRetouchingNaturalIcon,
    prefill: {
      adjustments: { ...DEFAULT_ADJUSTMENTS, sharpness: true, denoise: true },
      strength: 'subtle',
      preserveFaces: true,
    },
  },
  {
    key: 'custom',
    label: 'Custom',
    description: 'Choose the corrections yourself',
    Icon: TuneIcon,
    prefill: {
      adjustments: DEFAULT_ADJUSTMENTS,
      strength: 'balanced',
      preserveFaces: true,
    },
  },
];

export const PRESET_BY_KEY = new Map(PRESETS.map((p) => [p.key, p]));

// ---------------------------------------------------------------------------
// Params mapping
// ---------------------------------------------------------------------------

/**
 * Everything the params mapping reads. Both call sites hold these as individual
 * `useState`s and assemble this object on submit, so neither has to keep a
 * parallel "form model" in sync.
 */
export interface EnhanceFormState {
  presetKey: PresetKey;
  adjustments: AdjustmentsState;
  strength: EnhanceStrength;
  preserveFaces: boolean;
  instructions: string;
  /** Empty string = "let the server's pictureEnhancement.defaultQuality apply". */
  quality: EnhanceQuality | '';
}

/**
 * True when the user has actually deviated from the selected preset's prefill
 * (or typed free-text guidance) — NOT merely because the Customize panel is
 * expanded. This drives `intent`, which changes the prompt's opening sentence
 * server-side and is the only thing that makes `instructions` count.
 */
export function isFormCustomized(state: EnhanceFormState): boolean {
  const preset = PRESET_BY_KEY.get(state.presetKey) ?? PRESETS[0];
  return (
    !adjustmentsEqual(state.adjustments, preset.prefill.adjustments) ||
    state.strength !== preset.prefill.strength ||
    state.preserveFaces !== preset.prefill.preserveFaces ||
    state.instructions.trim().length > 0
  );
}

/**
 * Param mapping (deliberate, see issue #98 commit set E):
 *  - `preset` is sent for the four real presets only; `auto`/`custom` are UI
 *    affordances and send none.
 *  - `intent: 'custom'` is sent ONLY when the user genuinely customized. It
 *    swaps the prompt's base sentence and is the gate for `instructions`.
 *  - A preset's prefilled adjustments/strength/preserveFaces are still sent
 *    even when untouched, because they differ from the SERVER's defaults
 *    (e.g. portrait_polish = subtle). They are honored regardless of intent.
 *  - Full-auto with nothing touched sends `{}` so every server default wins.
 *
 * One `params` object applies to every photo in a batch — a bulk enhance is a
 * single intent applied across a selection, not per-photo tuning.
 */
export function buildEnhanceParams(state: EnhanceFormState): EnhanceParams {
  const params: EnhanceParams = {};

  if (state.presetKey !== 'auto' && state.presetKey !== 'custom') {
    params.preset = state.presetKey;
  }

  if (isFormCustomized(state)) {
    params.intent = 'custom';
    params.adjustments = { ...state.adjustments };
    params.strength = state.strength;
    params.preserveFaces = state.preserveFaces;
    const trimmed = state.instructions.trim();
    if (trimmed) params.instructions = trimmed;
  } else if (state.presetKey !== 'auto') {
    params.adjustments = { ...state.adjustments };
    params.strength = state.strength;
    params.preserveFaces = state.preserveFaces;
  }

  if (state.quality) params.quality = state.quality;

  return params;
}

// ---------------------------------------------------------------------------
// Preset card
// ---------------------------------------------------------------------------

export function PresetCard({
  def,
  selected,
  onSelect,
}: {
  def: PresetDef;
  selected: boolean;
  onSelect: () => void;
}) {
  const { Icon } = def;
  return (
    <ButtonBase
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${def.label} — ${def.description}`}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        textAlign: 'left',
        gap: 0.5,
        p: 1.25,
        minHeight: 96,
        width: '100%',
        borderRadius: 1.5,
        border: '2px solid',
        borderColor: selected ? 'primary.main' : 'divider',
        bgcolor: selected ? 'action.selected' : 'transparent',
        transition: 'border-color 120ms, background-color 120ms',
        '&:hover': { borderColor: selected ? 'primary.main' : 'text.disabled' },
        '&:focus-visible': {
          outline: '3px solid',
          outlineColor: 'primary.main',
          outlineOffset: 2,
        },
      }}
    >
      <Stack direction="row" spacing={0.75} sx={{ width: '100%', alignItems: 'center' }}>
        <Icon fontSize="small" color={selected ? 'primary' : 'action'} />
        <Typography variant="body2" sx={{ flex: 1, minWidth: 0, fontWeight: 600 }}>
          {def.label}
        </Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.3 }}>
        {def.description}
      </Typography>
      {def.interpretive && (
        <Chip
          size="small"
          color="warning"
          variant="outlined"
          label="Interpretive"
          sx={{ height: 20, '& .MuiChip-label': { px: 0.75, fontSize: 11 } }}
        />
      )}
    </ButtonBase>
  );
}

// ---------------------------------------------------------------------------
// Preset picker
// ---------------------------------------------------------------------------

export function PresetPicker({
  presetKey,
  onSelect,
  labelId,
}: {
  presetKey: PresetKey;
  onSelect: (key: PresetKey) => void;
  labelId: string;
}) {
  return (
    <Box
      role="group"
      aria-labelledby={labelId}
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
        gap: 1,
      }}
    >
      {PRESETS.map((def) => (
        <PresetCard
          key={def.key}
          def={def}
          selected={presetKey === def.key}
          onSelect={() => onSelect(def.key)}
        />
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Customize panel
// ---------------------------------------------------------------------------

/**
 * The collapsible advanced panel: six adjustment switches, strength, output
 * quality, face preservation and 500-char free-text guidance. Rendered
 * identically by the drawer and the batch dialog — one panel, so a knob added
 * to one surface can never be missing from the other.
 */
export function EnhanceCustomizePanel({
  open,
  adjustments,
  onAdjustmentsChange,
  strength,
  onStrengthChange,
  quality,
  onQualityChange,
  preserveFaces,
  onPreserveFacesChange,
  instructions,
  onInstructionsChange,
}: {
  open: boolean;
  adjustments: AdjustmentsState;
  onAdjustmentsChange: (next: AdjustmentsState) => void;
  strength: EnhanceStrength;
  onStrengthChange: (next: EnhanceStrength) => void;
  quality: EnhanceQuality | '';
  onQualityChange: (next: EnhanceQuality | '') => void;
  preserveFaces: boolean;
  onPreserveFacesChange: (next: boolean) => void;
  instructions: string;
  onInstructionsChange: (next: string) => void;
}) {
  return (
    <Collapse in={open} unmountOnExit>
      <Stack spacing={1.5}>
        {ADJUSTMENT_FIELDS.map(({ key, label }) => (
          <FormControlLabel
            key={key}
            control={
              <Switch
                size="small"
                checked={adjustments[key]}
                onChange={(e) =>
                  onAdjustmentsChange({ ...adjustments, [key]: e.target.checked })
                }
              />
            }
            label={label}
          />
        ))}

        <FormControl size="small" fullWidth>
          <InputLabel>Strength</InputLabel>
          <Select
            label="Strength"
            value={strength}
            onChange={(e) => onStrengthChange(e.target.value as EnhanceStrength)}
          >
            <MenuItem value="subtle">Subtle</MenuItem>
            <MenuItem value="balanced">Balanced</MenuItem>
            <MenuItem value="strong">Strong</MenuItem>
          </Select>
        </FormControl>

        <FormControl size="small" fullWidth>
          <InputLabel>Output quality</InputLabel>
          <Select
            label="Output quality"
            value={quality}
            onChange={(e) => onQualityChange(e.target.value as EnhanceQuality | '')}
          >
            <MenuItem value="">Default (set by administrator)</MenuItem>
            <MenuItem value="low">Low — fastest, cheapest</MenuItem>
            <MenuItem value="medium">Medium</MenuItem>
            <MenuItem value="high">High — slowest, best detail</MenuItem>
          </Select>
        </FormControl>

        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={preserveFaces}
              onChange={(e) => onPreserveFacesChange(e.target.checked)}
            />
          }
          label="Preserve faces & identities"
        />

        <TextField
          label="Additional instructions"
          size="small"
          fullWidth
          multiline
          minRows={2}
          value={instructions}
          onChange={(e) => onInstructionsChange(e.target.value.slice(0, 500))}
          placeholder="Optional guidance (max 500 chars)"
          helperText={`${instructions.length}/500`}
        />
      </Stack>
    </Collapse>
  );
}
