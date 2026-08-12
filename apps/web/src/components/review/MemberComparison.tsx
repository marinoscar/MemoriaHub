import { Fragment } from 'react';
import type { ReactNode } from 'react';
import {
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import StarIcon from '@mui/icons-material/Star';

/**
 * Member comparison matrix for the review screens (duplicate group detail today,
 * any future keep/discard comparison tomorrow).
 *
 * This is deliberately NOT a generic data table: it is a *member* comparison
 * whose column count grows with the group size, which is exactly the dimension a
 * phone does not have. So it renders in two orientations from ONE derived model
 * (see `deriveComparisonRows`):
 *
 *  - `md` and up: the classic attribute matrix — one column per member.
 *  - below `md`: one card per member, attributes stacked as label/value rows.
 *
 * Difference highlighting (amber emphasis on attributes whose values are not
 * identical across every member) is computed once and applied in both
 * orientations.
 */

export interface ComparisonColumn {
  /** Stable key — the member id. */
  id: string;
  /** Column header / card title, e.g. "Photo 2". */
  label: string;
  /** Renders the suggested-best star next to the label. */
  isSuggestedBest?: boolean;
}

export interface ComparisonCell {
  /** Plain-text value; drives difference detection and is the default display. */
  text: string;
  /** Optional richer rendering (icon, progress bar) shown instead of `text`. */
  content?: ReactNode;
}

export interface ComparisonRow {
  key: string;
  label: string;
  /** True when the members do not all share the same value for this attribute. */
  differs: boolean;
  /** One cell per column, index-aligned with `columns`. */
  cells: ComparisonCell[];
}

export interface ComparisonRowDef<T> {
  key: string;
  label: string;
  /** Plain-text value used for display and for the "differs" computation. */
  value: (member: T) => string;
  /** Optional richer rendering; falls back to `value`. */
  render?: (member: T) => ReactNode;
  /** Set false to opt out of difference highlighting (e.g. per-member scores). */
  compare?: boolean;
}

/**
 * Derive the per-member attribute rows and their "differs" flags ONCE, so the
 * mobile and desktop renderings can never drift apart.
 */
export function deriveComparisonRows<T>(
  members: T[],
  defs: ComparisonRowDef<T>[],
): ComparisonRow[] {
  return defs.map((def) => {
    const cells: ComparisonCell[] = members.map((m) => ({
      text: def.value(m),
      content: def.render?.(m),
    }));
    const differs =
      def.compare === false ? false : new Set(cells.map((c) => c.text)).size > 1;
    return { key: def.key, label: def.label, differs, cells };
  });
}

const DIFF_SX = {
  bgcolor: 'warning.main',
  color: 'warning.contrastText',
  opacity: 0.85,
} as const;

interface MemberComparisonProps {
  columns: ComparisonColumn[];
  rows: ComparisonRow[];
  /** Header for the attribute-label column (desktop matrix only). */
  attributeLabel?: string;
}

export function MemberComparison({
  columns,
  rows,
  attributeLabel = 'Attribute',
}: MemberComparisonProps) {
  const theme = useTheme();
  const isWide = useMediaQuery(theme.breakpoints.up('md'));

  if (!isWide) {
    return <StackedComparison columns={columns} rows={rows} />;
  }

  return (
    <TableContainer component={Paper} variant="outlined" sx={{ mb: 3, overflowX: 'auto' }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 600 }}>{attributeLabel}</TableCell>
            {columns.map((col) => (
              <TableCell key={col.id} align="center" sx={{ fontWeight: 600, minWidth: 140 }}>
                <Box
                  sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5 }}
                >
                  {col.isSuggestedBest && (
                    <Tooltip title="Suggested best copy">
                      <StarIcon fontSize="small" sx={{ color: 'warning.main' }} />
                    </Tooltip>
                  )}
                  {col.label}
                </Box>
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell sx={{ fontWeight: 500 }}>{row.label}</TableCell>
              {columns.map((col, idx) => {
                const cell = row.cells[idx];
                return (
                  <TableCell
                    key={col.id}
                    align="center"
                    sx={row.differs ? DIFF_SX : undefined}
                  >
                    {cell?.content ?? cell?.text ?? '—'}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/**
 * Transposed rendering for phones/tablets: one card per member so width stays
 * constant no matter how many members the group has.
 */
function StackedComparison({ columns, rows }: { columns: ComparisonColumn[]; rows: ComparisonRow[] }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 3 }}>
      {columns.map((col, idx) => (
        <Paper key={col.id} variant="outlined" sx={{ p: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
            {col.isSuggestedBest && (
              <Tooltip title="Suggested best copy">
                <StarIcon fontSize="small" sx={{ color: 'warning.main' }} />
              </Tooltip>
            )}
            <Typography variant="subtitle2" component="h3">
              {col.label}
            </Typography>
          </Box>
          <Box
            component="dl"
            sx={{
              m: 0,
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 8rem) minmax(0, 1fr)',
              columnGap: 1.5,
              rowGap: 0.75,
              alignItems: 'center',
            }}
          >
            {rows.map((row) => {
              const cell = row.cells[idx];
              return (
                <Fragment key={row.key}>
                  <Typography
                    component="dt"
                    variant="caption"
                    color="text.secondary"
                    sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
                  >
                    {row.label}
                  </Typography>
                  <Box
                    component="dd"
                    sx={{
                      m: 0,
                      minWidth: 0,
                      overflowWrap: 'anywhere',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.5,
                      ...(row.differs
                        ? { ...DIFF_SX, borderRadius: 0.5, px: 0.75, py: 0.25 }
                        : {}),
                    }}
                  >
                    {cell?.content ?? (
                      <Typography variant="body2" component="span" sx={{ color: 'inherit' }}>
                        {cell?.text ?? '—'}
                      </Typography>
                    )}
                  </Box>
                </Fragment>
              );
            })}
          </Box>
        </Paper>
      ))}
    </Box>
  );
}
