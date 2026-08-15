import type { ComponentType } from 'react';
import { ButtonBase, Chip, Stack, Typography } from '@mui/material';
import type { SvgIconProps } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import HealingIcon from '@mui/icons-material/Healing';
import NightlightIcon from '@mui/icons-material/Nightlight';
import PaletteIcon from '@mui/icons-material/Palette';
import FaceRetouchingNaturalIcon from '@mui/icons-material/FaceRetouchingNatural';
import TuneIcon from '@mui/icons-material/Tune';
import type {
  EnhanceParams,
  EnhancePreset,
  EnhanceQuality,
  EnhanceStrength,
} from '../../services/enhance';

// ---------------------------------------------------------------------------
// Shared AI-enhance preset vocabulary (epic #420).
//
// Single source of truth for the preset catalog, the adjustment switches, the
// preset card, and the params builder. Consumed by BOTH the single-item
// MediaEnhancementDrawer and the multi-photo BatchEnhanceDialog — two copies of
// this catalog would let the same "Restore old photo" button mean two different
// things depending on how many photos happened to be selected.
// ---------------------------------------------------------------------------

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
    prefill: {
      adjustments: { ...DEFAULT_ADJUSTMENTS, tone: true, sharpness: true, denoise: true, dehaze: true },
      strength: 'strong',
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

/** The preset a key resolves to, falling back to `auto` for an unknown key. */
export function resolvePreset(key: PresetKey): PresetDef {
  return PRESET_BY_KEY.get(key) ?? PRESETS[0];
}

// ---------------------------------------------------------------------------
// Params builder
// ---------------------------------------------------------------------------

/**
 * The editable form state both enhance surfaces collect. `quality: ''` means
 * "let the server's `pictureEnhancement.defaultQuality` apply".
 */
export interface EnhanceFormState {
  presetKey: PresetKey;
  adjustments: AdjustmentsState;
  strength: EnhanceStrength;
  preserveFaces: boolean;
  instructions: string;
  quality: EnhanceQuality | '';
}

/**
 * True when the user has actually deviated from the selected preset's prefill
 * (or typed free-text guidance) — NOT merely because the Customize panel is
 * expanded. This drives `intent`, which changes the prompt's opening sentence
 * server-side and is the only thing that makes `instructions` count.
 */
export function isEnhanceCustomized(state: EnhanceFormState): boolean {
  const preset = resolvePreset(state.presetKey);
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
 */
export function buildEnhanceParams(state: EnhanceFormState): EnhanceParams {
  const params: EnhanceParams = {};

  if (state.presetKey !== 'auto' && state.presetKey !== 'custom') {
    params.preset = state.presetKey;
  }

  if (isEnhanceCustomized(state)) {
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
