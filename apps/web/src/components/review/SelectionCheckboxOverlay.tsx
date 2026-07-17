import { Box } from '@mui/material';
import { MediaSelectionCheckbox } from '../media/MediaSelectionCheckbox';

interface SelectionCheckboxOverlayProps {
  checked: boolean;
  onToggle: () => void;
  ariaLabel: string;
}

/**
 * Selection checkbox overlay for review cards/tiles (burst + duplicate queues).
 * Positions the shared MediaSelectionCheckbox (same control as the main gallery
 * tiles) at the top-left of the host card. The `comfortableTouchTarget` variant
 * keeps a >=44px tap target for mobile.
 */
export function SelectionCheckboxOverlay({
  checked,
  onToggle,
  ariaLabel,
}: SelectionCheckboxOverlayProps) {
  return (
    <Box
      sx={{
        position: 'absolute',
        top: 8,
        left: 8,
        zIndex: 2,
      }}
    >
      <MediaSelectionCheckbox
        checked={checked}
        onToggle={onToggle}
        ariaLabel={ariaLabel}
        comfortableTouchTarget
      />
    </Box>
  );
}
