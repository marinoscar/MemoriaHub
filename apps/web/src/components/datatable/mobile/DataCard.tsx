/**
 * DataTable — one row, as a card.
 *
 * Layout is driven entirely by `priority`, never by column order or by any
 * mobile-specific declaration on the column:
 *
 *   primary   → card headline (the thing you scan a list for)
 *   secondary → card body, as stacked label/value pairs
 *   detail    → collapsed behind "More details", CLOSED by default
 *
 * Visual language follows the burst/duplicate/location review queues, which are
 * the surfaces in this app that already work well on a phone: an outlined
 * `Card`, a checkbox at the leading edge, a single trailing overflow control,
 * and body text at `body2` / `text.secondary`.
 *
 * Touch-target rule (issue #243): every control here is >=44px and none of them
 * is hidden with `opacity: 0` while staying clickable. There are no
 * hover-revealed affordances on a card at all — a card list is a touch surface
 * first, and an invisible-but-tappable control is the exact bug #243 filed.
 */

import { useId, useState } from 'react';
import {
  Box,
  Card,
  Checkbox,
  Collapse,
  Divider,
  Stack,
  Typography,
  ButtonBase,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from '@mui/icons-material';
import type { DataTableColumn, DataTableRowAction } from '../types';
import { RowActionsCell } from '../desktop/RowActionsCell';
import { CardField, columnContent, columnText } from './CardField';

export interface DataCardProps<Row> {
  row: Row;
  id: string;
  primaryColumns: DataTableColumn<Row>[];
  secondaryColumns: DataTableColumn<Row>[];
  detailColumns: DataTableColumn<Row>[];
  selectable: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  rowActions?: DataTableRowAction<Row>[];
  onRunAction: (action: DataTableRowAction<Row>, row: Row) => void;
}

export function DataCard<Row>({
  row,
  id,
  primaryColumns,
  secondaryColumns,
  detailColumns,
  selectable,
  selected,
  onToggleSelect,
  rowActions,
  onRunAction,
}: DataCardProps<Row>) {
  const [expanded, setExpanded] = useState(false);
  const detailRegionId = useId();

  const hasDetail = detailColumns.length > 0;
  const hasActions = Boolean(rowActions && rowActions.length > 0);

  // The first `primary` column doubles as the card's accessible name and as the
  // disambiguator on the actions menu ("Row actions for face_detection").
  const headlineText = primaryColumns.length > 0 ? columnText(primaryColumns[0], row) : id;

  return (
    <Card
      variant="outlined"
      component="li"
      data-testid="datatable-card"
      data-row-id={id}
      data-selected={selected ? 'true' : 'false'}
      sx={{
        listStyle: 'none',
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        ...(selected
          ? {
              borderColor: 'primary.main',
              bgcolor: (theme) =>
                theme.palette.mode === 'dark'
                  ? 'rgba(144, 202, 249, 0.10)'
                  : 'rgba(25, 118, 210, 0.06)',
            }
          : {}),
      }}
    >
      {/* --- Header: selection, headline, actions ---------------------------- */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1,
          px: 1.5,
          py: 1.25,
          minWidth: 0,
        }}
      >
        {selectable && (
          <Checkbox
            checked={selected}
            onChange={() => onToggleSelect(id)}
            slotProps={{ input: { 'aria-label': 'Select row' } }}
            sx={{ minWidth: 44, minHeight: 44, mt: -0.5, ml: -0.5 }}
          />
        )}

        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          {primaryColumns.map((column, index) => (
            <Typography
              key={column.id}
              data-testid={`datatable-card-headline-${column.id}`}
              variant={index === 0 ? 'subtitle2' : 'body2'}
              component="div"
              color={index === 0 ? 'text.primary' : 'text.secondary'}
              sx={{
                fontWeight: index === 0 ? 700 : 400,
                minWidth: 0,
                overflowWrap: 'anywhere',
              }}
            >
              {columnContent(column, row)}
            </Typography>
          ))}
        </Box>

        {hasActions && (
          <RowActionsCell
            row={row}
            actions={rowActions ?? []}
            rowLabel={headlineText}
            onRun={onRunAction}
            alwaysMenu
            touchTarget
          />
        )}
      </Box>

      {/* --- Body: secondary fields ----------------------------------------- */}
      {secondaryColumns.length > 0 && (
        <>
          <Divider />
          <Stack spacing={1.25} sx={{ px: 1.5, py: 1.25, minWidth: 0 }}>
            {secondaryColumns.map((column) => (
              <CardField key={column.id} column={column} row={row} />
            ))}
          </Stack>
        </>
      )}

      {/* --- Detail: collapsed by default ------------------------------------ */}
      {hasDetail && (
        <>
          <Divider />
          <ButtonBase
            data-testid="datatable-card-detail-toggle"
            aria-expanded={expanded}
            aria-controls={detailRegionId}
            aria-label={`${expanded ? 'Hide' : 'More'} details for ${headlineText}`}
            onClick={() => setExpanded((value) => !value)}
            sx={{
              display: 'flex',
              width: '100%',
              minHeight: 44,
              px: 1.5,
              py: 1,
              gap: 0.5,
              justifyContent: 'flex-start',
              alignItems: 'center',
              color: 'primary.main',
              typography: 'body2',
              fontWeight: 600,
            }}
          >
            {expanded ? (
              <ExpandLessIcon fontSize="small" />
            ) : (
              <ExpandMoreIcon fontSize="small" />
            )}
            {expanded ? 'Fewer details' : 'More details'}
          </ButtonBase>

          <Collapse in={expanded} unmountOnExit>
            <Box
              id={detailRegionId}
              data-testid="datatable-card-detail-region"
              sx={{
                px: 1.5,
                pb: 1.5,
                minWidth: 0,
                bgcolor: (theme) =>
                  theme.palette.mode === 'dark'
                    ? 'rgba(255, 255, 255, 0.03)'
                    : 'rgba(0, 0, 0, 0.02)',
              }}
            >
              <Stack spacing={1.25} sx={{ pt: 1.25, minWidth: 0 }}>
                {detailColumns.map((column) => (
                  <CardField key={column.id} column={column} row={row} />
                ))}
              </Stack>
            </Box>
          </Collapse>
        </>
      )}
    </Card>
  );
}
