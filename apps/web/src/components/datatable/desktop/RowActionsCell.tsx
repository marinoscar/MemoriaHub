/**
 * DataTable — per-row actions cell.
 *
 * One action renders as a bare icon button (with a tooltip carrying the label);
 * two or more collapse into an overflow menu, mirroring the hand-rolled
 * `MoreVert` menus in JobsPage / UserList that this component replaces.
 *
 * The cell never executes an action itself — it hands the descriptor back to
 * the renderer, which owns the (single, shared) confirmation dialog.
 */

import { useState } from 'react';
import type { MouseEvent } from 'react';
import {
  IconButton,
  Tooltip,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Stack,
} from '@mui/material';
import { MoreVert as MoreVertIcon } from '@mui/icons-material';
import type { DataTableRowAction } from '../types';

export interface RowActionsCellProps<Row> {
  row: Row;
  actions: DataTableRowAction<Row>[];
  /** Label used to disambiguate the menu button for screen readers. */
  rowLabel?: string;
  onRun: (action: DataTableRowAction<Row>, row: Row) => void;
}

export function RowActionsCell<Row>({ row, actions, rowLabel, onRun }: RowActionsCellProps<Row>) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  if (actions.length === 0) return null;

  const suffix = rowLabel ? ` for ${rowLabel}` : '';

  // --- Single action: a plain icon button -----------------------------------
  if (actions.length === 1) {
    const action = actions[0];
    const disabled = action.disabled?.(row) ?? false;
    return (
      <Stack direction="row" sx={{ width: "100%", justifyContent: "flex-end" }}>
        <Tooltip title={action.label}>
          {/* span keeps the tooltip working while the button is disabled */}
          <span>
            <IconButton
              size="small"
              aria-label={`${action.label}${suffix}`}
              disabled={disabled}
              color={action.destructive ? 'error' : 'default'}
              onClick={(event: MouseEvent<HTMLElement>) => {
                event.stopPropagation();
                onRun(action, row);
              }}
            >
              {action.icon ?? <MoreVertIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    );
  }

  // --- Multiple actions: overflow menu --------------------------------------
  const open = Boolean(anchorEl);
  return (
    <Stack direction="row" sx={{ width: "100%", justifyContent: "flex-end" }}>
      <IconButton
        size="small"
        aria-label={`Row actions${suffix}`}
        aria-haspopup="menu"
        aria-expanded={open ? true : undefined}
        onClick={(event: MouseEvent<HTMLElement>) => {
          event.stopPropagation();
          setAnchorEl(event.currentTarget);
        }}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchorEl} open={open} onClose={() => setAnchorEl(null)}>
        {actions.map((action) => (
          <MenuItem
            key={action.id}
            disabled={action.disabled?.(row) ?? false}
            sx={action.destructive ? { color: 'error.main' } : undefined}
            onClick={(event: MouseEvent<HTMLElement>) => {
              event.stopPropagation();
              setAnchorEl(null);
              onRun(action, row);
            }}
          >
            {action.icon && (
              <ListItemIcon sx={action.destructive ? { color: 'error.main' } : undefined}>
                {action.icon}
              </ListItemIcon>
            )}
            <ListItemText primary={action.label} />
          </MenuItem>
        ))}
      </Menu>
    </Stack>
  );
}
