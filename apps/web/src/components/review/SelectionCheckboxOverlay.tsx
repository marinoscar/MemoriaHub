import { Box, Checkbox } from '@mui/material';

interface SelectionCheckboxOverlayProps {
  checked: boolean;
  onToggle: () => void;
  ariaLabel: string;
}

/**
 * Reusable selection checkbox overlay for review cards/tiles (burst + duplicate
 * queues). A dark circular puck wrapping a medium MUI Checkbox, sized to a
 * comfortable >=44px touch target for mobile. Stops click propagation so the
 * host card's onClick toggle isn't double-fired.
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
        bgcolor: 'rgba(0,0,0,0.5)',
        borderRadius: '50%',
        minWidth: 44,
        minHeight: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Checkbox
        checked={checked}
        sx={{ color: 'common.white', p: 1, '&.Mui-checked': { color: 'common.white' } }}
        tabIndex={-1}
        slotProps={{ input: { 'aria-label': ariaLabel } }}
      />
    </Box>
  );
}
