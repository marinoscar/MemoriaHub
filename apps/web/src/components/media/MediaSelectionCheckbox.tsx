import { IconButton } from '@mui/material';
import {
  CheckBox as CheckBoxIcon,
  CheckBoxOutlineBlank as CheckBoxOutlineBlankIcon,
} from '@mui/icons-material';

interface MediaSelectionCheckboxProps {
  checked: boolean;
  onToggle: () => void;
  ariaLabel: string;
  /**
   * When true, enforces a >=44px touch target (used by the burst/duplicate
   * review overlays for comfortable mobile tapping). When false (default),
   * uses the compact gallery-tile density.
   */
  comfortableTouchTarget?: boolean;
}

/**
 * Shared media selection checkbox. Single source of truth for the selection
 * control used by both the main gallery tiles and the burst/duplicate review
 * cards/tiles, so the two surfaces stay visually identical. Presentational
 * only — the host positions it; this component owns the look + click toggle.
 */
export function MediaSelectionCheckbox({
  checked,
  onToggle,
  ariaLabel,
  comfortableTouchTarget = false,
}: MediaSelectionCheckboxProps) {
  return (
    <IconButton
      size="small"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-label={ariaLabel}
      sx={{
        color: checked ? 'primary.main' : 'white',
        backgroundColor: 'rgba(0,0,0,0.4)',
        '&:hover': { backgroundColor: 'rgba(0,0,0,0.6)' },
        ...(comfortableTouchTarget
          ? { minWidth: 44, minHeight: 44, p: 1 }
          : { p: { xs: 0.5, sm: 0.25 } }),
      }}
    >
      {checked ? (
        <CheckBoxIcon fontSize="small" />
      ) : (
        <CheckBoxOutlineBlankIcon fontSize="small" />
      )}
    </IconButton>
  );
}
