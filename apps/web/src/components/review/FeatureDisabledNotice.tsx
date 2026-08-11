/**
 * "This review feature is turned off" — the banner the three queue pages show
 * when their global feature flag is disabled (issue #404).
 *
 * WHY A BANNER AND NOT A GUARD
 * ----------------------------
 * `BurstsPage`, `DuplicatesPage` and `LocationSuggestionsPage` have never had a
 * feature gate of their own: with the flag off they still fetch, still list
 * whatever groups exist, and still resolve them. Groups created while the flag
 * was on — or by an admin backfill — stay in the database and stay actionable.
 * A route guard or a redirect would therefore take a WORKING page away from a
 * user with real work waiting, which is the bug this issue is fixing one level
 * up in the navigation. So the page stays reachable and stays fully functional;
 * the only thing added is an honest explanation.
 *
 * It sits ABOVE the existing content rather than replacing it, for the same
 * reason: the residual groups are exactly what the user came for. Replacing the
 * list would hide them behind the very message that says they exist.
 *
 * Without this, a disabled feature rendered an empty list VISUALLY IDENTICAL to
 * "nothing pending" — the page said "No duplicate groups to review" when the
 * truth was "nothing is looking for them".
 */

import { Alert, AlertTitle, Box, Button, Typography } from '@mui/material';
import { Settings as SettingsIcon } from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';

export interface FeatureDisabledNoticeProps {
  /** Sentence-case feature name, e.g. "Duplicate detection". */
  featureLabel: string;
  /** Admin settings route that owns this feature's global toggle. */
  settingsPath: string;
  /**
   * Whether the page currently has groups on screen. It changes what the user
   * needs to be told: with items, the point is "these are still yours to
   * review"; without, the point is "nothing new will ever appear".
   */
  hasExistingWork: boolean;
}

export function FeatureDisabledNotice({
  featureLabel,
  settingsPath,
  hasExistingWork,
}: FeatureDisabledNoticeProps) {
  // Read here rather than at each call site: the link is only useful to someone
  // who can actually follow it, and every caller would otherwise repeat the
  // same check.
  const { isAdmin } = usePermissions();

  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      <AlertTitle>{featureLabel} is turned off</AlertTitle>
      <Typography variant="body2" component="p">
        {hasExistingWork
          ? 'Nothing new is being detected, but the items found earlier are listed below and can still be reviewed.'
          : 'Nothing new is being detected, so no new items will appear here.'}{' '}
        {isAdmin
          ? 'Turn it back on in the feature settings.'
          : 'An administrator can turn it back on.'}
      </Typography>
      {isAdmin && (
        <Box sx={{ mt: 1 }}>
          <Button
            component={RouterLink}
            to={settingsPath}
            size="small"
            startIcon={<SettingsIcon />}
          >
            Open settings
          </Button>
        </Box>
      )}
    </Alert>
  );
}

export default FeatureDisabledNotice;
