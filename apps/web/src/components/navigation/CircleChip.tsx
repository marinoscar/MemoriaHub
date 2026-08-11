/**
 * CircleChip — the active-circle switcher, promoted into the top bar.
 *
 * Spec §3.3 / §4.1: the active circle is the app's most important state and was
 * previously two taps deep inside the avatar menu (open avatar → pick circle).
 * Surfacing it as always-visible chrome makes "which library am I looking at?"
 * answerable at a glance and switchable in one tap, and is what lets `UserMenu`
 * drop its circle section entirely rather than becoming a second path to the
 * same action.
 *
 * Rendered as a real `<button>` (not MUI's `Chip`, whose clickable form is a
 * `div` with `role="button"`) so it is keyboard- and AT-native for free, then
 * styled as a pill. §7 requires the accessible name to carry the circle name,
 * since the visible label is truncated at narrow widths.
 */

import { useState, useCallback } from 'react';
import { Box, Button, Divider, ListItemText, Menu, MenuItem } from '@mui/material';
import {
  ArrowDropDown as ArrowDropDownIcon,
  GroupWork as GroupWorkIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';

export function CircleChip() {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const { circles, activeCircle, setActiveCircle } = useCircle();
  const navigate = useNavigate();

  const open = Boolean(anchorEl);

  const handleOpen = useCallback((event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  }, []);

  const handleClose = useCallback(() => setAnchorEl(null), []);

  const handleSelect = useCallback(
    (circleId: string) => {
      handleClose();
      void setActiveCircle(circleId);
    },
    [handleClose, setActiveCircle],
  );

  const handleManage = useCallback(() => {
    handleClose();
    navigate('/circles');
  }, [handleClose, navigate]);

  // Before CircleContext resolves (and for a user who somehow has no circle)
  // there is nothing to name, and an empty pill would read as a broken control
  // rather than a loading one.
  if (!activeCircle) return null;

  return (
    <>
      <Button
        onClick={handleOpen}
        color="inherit"
        endIcon={<ArrowDropDownIcon />}
        aria-haspopup="true"
        aria-expanded={open ? 'true' : undefined}
        aria-controls={open ? 'circle-chip-menu' : undefined}
        aria-label={`Active circle: ${activeCircle.name}. Change circle.`}
        sx={{
          // `minWidth: 0` + `flexShrink: 1` + a capped `maxWidth` are the three
          // halves of one rule: a long circle name must never widen the
          // toolbar. Without `minWidth: 0` a flex item's min-width is its
          // min-content width, so "Extended Family Photos" would push the row
          // past the viewport and give the whole app a horizontal scrollbar —
          // the same failure mode as issue #291 (see the `minWidth: 0` comment
          // in `common/Layout.tsx`). The cap tightens hard on phone, where the
          // toolbar's width budget is nearly spent before the chip is added.
          minWidth: 0,
          flexShrink: 1,
          maxWidth: { xs: 108, sm: 160, md: 200 },
          height: 36, // ≥36px touch target; MUI's own Chip is only 32.
          px: { xs: 0.75, sm: 1 },
          borderRadius: 5,
          textTransform: 'none',
          fontWeight: 500,
          backgroundColor: 'action.hover',
          '&:hover': { backgroundColor: 'action.selected' },
          // The trailing caret is the affordance; the leading icon is
          // decoration, and on phone the pixels are worth more as label.
          '& .MuiButton-endIcon': { ml: 0.25, mr: -0.5 },
        }}
      >
        <Box
          component="span"
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {activeCircle.name}
        </Box>
      </Button>

      <Menu
        id="circle-chip-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        transformOrigin={{ horizontal: 'left', vertical: 'top' }}
        anchorOrigin={{ horizontal: 'left', vertical: 'bottom' }}
        slotProps={{
          paper: { sx: { minWidth: 220, maxWidth: 320, mt: 0.5 } },
        }}
      >
        {circles.map((c) => (
          <MenuItem
            key={c.id}
            selected={c.id === activeCircle.id}
            onClick={() => handleSelect(c.id)}
          >
            <ListItemText
              primary={c.name}
              slotProps={{ primary: { noWrap: true } }}
            />
          </MenuItem>
        ))}

        <Divider />

        <MenuItem onClick={handleManage}>
          <ListItemText primary="Manage Circles" />
          <GroupWorkIcon fontSize="small" sx={{ ml: 2, color: 'text.secondary' }} />
        </MenuItem>
      </Menu>
    </>
  );
}
