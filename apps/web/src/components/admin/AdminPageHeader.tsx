/**
 * The admin console's page header — ONE declaration, ~24 consumers.
 *
 * Every admin page used to hand-roll the same three elements: a
 * "← Back to Settings" link, an icon + `h4` title row, and a description
 * paragraph. That was fine on a desktop and broken on a phone, because it
 * predates the Console drill-down chrome (epic #388 / issue #389) that now
 * renders a back arrow AND the resolved page title in the AppBar below `sm`
 * (`AppBar.tsx`: `adminDrillDown = isCompactWindow && isAdminRoute`).
 *
 * Issue #451. Three things this component fixes that no page could fix alone:
 *
 *   1. **The back link is redundant below `sm`** — the AppBar arrow already
 *      navigates to the identical `ADMIN_HUB_PATH`. It is hidden with a
 *      breakpoint on `display`, deliberately NOT with `useMediaQuery`: a hook
 *      would re-render the whole page on resize and, because it resolves
 *      `false` on the first paint, would flash the link in on every mount.
 *      Hiding rather than unmounting also keeps the wide-viewport a11y tree
 *      and every existing `getByRole('link', { name: /Back to Settings/ })`
 *      assertion working untouched.
 *
 *   2. **The title was an unconditional `h4`** (2.125rem). At 360px the longer
 *      titles wrap to two lines. `variant` stays `h4` — the typographic scale
 *      and every `getByRole('heading', { level: 1 })` query depend on it — and
 *      only the rendered `fontSize` is made responsive.
 *
 *   3. **The icon was centred against the whole title block** (`alignItems:
 *      'center'`), so the moment the title wrapped, the icon floated at the
 *      midpoint beside the line break instead of sitting beside the first
 *      line. `flex-start` plus a small optical nudge fixes that at every width;
 *      on a single-line title the two are visually indistinguishable.
 *
 * `actions` is the optional right-hand slot (Doctor's "Run diagnostics", Jobs'
 * refresh controls). It carries its own wrap guard for the same reason #438
 * added them elsewhere: a flex row of buttons left at the default
 * `flex-shrink: 1` compresses past its labels rather than moving to a new line.
 */

import type { ReactNode } from 'react';
import { Box, Link, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { ADMIN_HUB_PATH } from '../../config/adminSections';

/**
 * The "← Back to Settings" link on its own, for the handful of admin pages
 * whose header is bespoke enough that `AdminPageHeader` would change their
 * visual design (an `h5` title with a subtitle beside it, say). They still
 * need the one thing that is not a design choice: the link is redundant below
 * `sm`, where the AppBar's drill-down arrow already goes to the same place.
 */
export function AdminBackLink({ to = ADMIN_HUB_PATH }: { to?: string }) {
  return (
    <Link
      component={RouterLink}
      to={to}
      underline="hover"
      variant="body2"
      // Hidden, not unmounted — see the note (1) in the file header.
      sx={{ display: { xs: 'none', sm: 'inline-block' }, mb: 2 }}
    >
      &larr; Back to Settings
    </Link>
  );
}

export interface AdminPageHeaderProps {
  /** Rendered as the page's single `<h1>`. */
  title: ReactNode;
  /** Optional leading glyph, e.g. `<ArchiveIcon color="primary" />`. */
  icon?: ReactNode;
  /**
   * Rendered immediately after the title and OUTSIDE the `<h1>` — a status
   * chip belongs beside a heading, not inside its accessible name.
   */
  titleAdornment?: ReactNode;
  /** The `text.secondary` paragraph under the title. */
  description?: ReactNode;
  /** Where the back link points. Defaults to the admin hub. */
  backTo?: string;
  /** Optional trailing controls, wrap-guarded. */
  actions?: ReactNode;
}

export function AdminPageHeader({
  title,
  icon,
  titleAdornment,
  description,
  backTo = ADMIN_HUB_PATH,
  actions,
}: AdminPageHeaderProps) {
  return (
    <>
      <AdminBackLink to={backTo} />

      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 1,
          rowGap: 1,
          mb: description ? 1 : 3,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, minWidth: 0 }}>
          {icon ? (
            // `0.15em` lines the glyph up with the first line's cap height. The
            // icon must never shrink; the title is the only flexible child.
            <Box sx={{ display: 'flex', flexShrink: 0, mt: '0.15em' }}>{icon}</Box>
          ) : null}
          <Typography
            variant="h4"
            component="h1"
            sx={{
              minWidth: 0,
              lineHeight: 1.25,
              fontSize: { xs: '1.5rem', sm: '2.125rem' },
              overflowWrap: 'anywhere',
            }}
          >
            {title}
          </Typography>
          {titleAdornment ? (
            <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, mt: '0.15em' }}>
              {titleAdornment}
            </Box>
          ) : null}
        </Box>

        {actions ? (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 1,
              rowGap: 1,
              '& > *': { flexShrink: 0, whiteSpace: 'nowrap' },
            }}
          >
            {actions}
          </Box>
        ) : null}
      </Box>

      {description ? (
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {description}
        </Typography>
      ) : null}
    </>
  );
}

export default AdminPageHeader;
