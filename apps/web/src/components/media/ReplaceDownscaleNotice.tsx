import { Alert, AlertTitle, Link, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { usePermissions } from '../../hooks/usePermissions';

/**
 * The always-visible explanation of the AI Picture Enhancer's replace policy
 * (issue #426).
 *
 * WHY THIS EXISTS: the reason a replace was unavailable used to live only in a
 * MUI `Tooltip` wrapped around a `disabled` `Button`. A disabled button fires
 * no pointer events and the wrapping `<span>` is neither focusable nor
 * clickable, so that tooltip is hover-only — on a phone or tablet the button
 * was simply inert and silent. The reason must therefore be rendered into the
 * DOM unconditionally, never behind an interaction. Do not regress this back
 * into a tooltip.
 *
 * It also surfaces the responsible admin setting, since the block is policy
 * rather than a property of the photo, and an Admin who could fix it in one
 * click previously had no way to learn that from here.
 */

const ENHANCER_SETTINGS_PATH = '/admin/settings/enhancer';

function megapixels(width: number | null, height: number | null): string | null {
  if (width == null || height == null || width <= 0 || height <= 0) return null;
  return `${((width * height) / 1_000_000).toFixed(1)} MP`;
}

/**
 * "3168×3928 (12.4 MP) → 1024×1536 (1.6 MP)", degrading gracefully to just the
 * dimensions (or null) when the server did not report them.
 */
export function describeResolutionLoss(
  originalWidth: number | null,
  originalHeight: number | null,
  enhancedWidth: number | null,
  enhancedHeight: number | null,
): string | null {
  if (
    originalWidth == null ||
    originalHeight == null ||
    enhancedWidth == null ||
    enhancedHeight == null
  ) {
    return null;
  }
  const from = megapixels(originalWidth, originalHeight);
  const to = megapixels(enhancedWidth, enhancedHeight);
  const fromLabel = from ? `${originalWidth}×${originalHeight} (${from})` : `${originalWidth}×${originalHeight}`;
  const toLabel = to ? `${enhancedWidth}×${enhancedHeight} (${to})` : `${enhancedWidth}×${enhancedHeight}`;
  return `${fromLabel} → ${toLabel}`;
}

interface ReplaceDownscaleNoticeProps {
  /**
   * True when `pictureEnhancement.blockReplaceOnDownscale` is on AND this
   * result is downscaled — i.e. replacing needs an explicit acknowledgement.
   * When false the notice is a plain resolution-loss warning.
   */
  policyBlocked: boolean;
  /** Formatted "before → after" resolution summary, when known. */
  resolutionLoss?: string | null;
  /** `dense` drops the title, for the tighter review-hub card. */
  dense?: boolean;
}

export function ReplaceDownscaleNotice({
  policyBlocked,
  resolutionLoss,
  dense = false,
}: ReplaceDownscaleNoticeProps) {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission('system_settings:write');

  return (
    <Alert
      severity="warning"
      variant="outlined"
      icon={<WarningAmberIcon fontSize="inherit" />}
      sx={{ '& .MuiAlert-message': { minWidth: 0 } }}
    >
      {!dense && (
        <AlertTitle>
          {policyBlocked ? 'Replacing needs your confirmation' : 'Lower resolution'}
        </AlertTitle>
      )}
      <Typography variant="body2" component="div">
        The enhanced image is lower resolution than the original
        {resolutionLoss ? ` (${resolutionLoss})` : ''}.{' '}
        {policyBlocked ? (
          <>
            An administrator has set replacing to be blocked when the result is
            smaller, so replacing asks you to confirm the resolution loss first.
            &quot;Keep both&quot; leaves the original untouched.
          </>
        ) : (
          <>Replacing will permanently lower this photo&apos;s resolution.</>
        )}
        {policyBlocked && canManage && (
          <>
            {' '}
            <Link component={RouterLink} to={ENHANCER_SETTINGS_PATH}>
              Change this setting
            </Link>
          </>
        )}
      </Typography>
    </Alert>
  );
}
