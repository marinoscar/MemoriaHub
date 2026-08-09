// ---------------------------------------------------------------------------
// NotificationSettings — per-type notification preferences (issue #251, the
// last child of epic #240).
//
// THE ABSENT-KEY CONTRACT (load-bearing — read before editing)
// -----------------------------------------------------------
// The `notifications` namespace lives inside `user_settings` and is stored
// SPARSELY. An absent namespace, an absent `enabled`, or an absent per-type key
// all mean ENABLED. That is what lets the feature ship without a migration
// (nobody is muted by its arrival) and makes a NotificationType added in a
// later release opt-OUT rather than silently opt-in for anyone who ever saved a
// preference.
//
// So this component:
//   * DERIVES every switch from `settings.notifications` with `!== false`,
//     never from a defaulted local object;
//   * NEVER writes a full preferences object — not on mount, not on first
//     change. Each toggle PATCHes exactly the one key it changed, and the API's
//     per-key merge leaves everything else absent;
//   * re-enabling a type sends `types: { [type]: null }` — a JSON Merge Patch
//     DELETE that restores the absent (= enabled) state — rather than pinning
//     it to `true`. Writing `true` would work today but would opt that user in
//     permanently and grow the blob for no reason.
//
// The single inversion is `workflowMicroRuns`, which is OFF when absent (#247
// suppresses `on_media_enriched` micro-runs by default because they fire
// continuously during an import). There is no null-delete for it — it is a
// plain boolean either way — so it is written explicitly.
//
// `enabled` likewise has no null form in the PATCH schema, so turning the
// master switch back on writes `enabled: true`. That materializes ONE key, and
// only for a user who deliberately turned notifications off and on again — it
// never happens to somebody who has not touched this page.
//
// WHY SWITCHES SAVE IMMEDIATELY (no Save button)
// ----------------------------------------------
// A batched save would have to hold a full local mirror of the preferences and
// diff it, which is exactly the shape that ends up POSTing a materialized
// object. Saving per toggle keeps each request a one-key delta and keeps
// `settings` the single source of truth for what is on. Controls are disabled
// while a save is in flight so two toggles cannot race the `If-Match` version.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import {
  Alert,
  Box,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  FormControlLabel,
  Switch,
  Typography,
} from '@mui/material';

import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import { usePermissions } from '../../hooks/usePermissions';
import type { UserSettings, UserSettingsUpdate } from '../../types';
import type {
  NotificationPreferencesPatch,
  NotificationType,
} from '../../types/notifications';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Global feature flag a notification type belongs to.
 *
 * `pictureEnhancement` is resolved from `GET /api/features`' dedicated
 * `pictureEnhancement.enabled` field rather than the raw flag record, because
 * that field already folds in the `PICTURE_ENHANCEMENT_ENABLED` env
 * kill-switch server-side.
 */
type FeatureFlagKey =
  | 'burstDetection'
  | 'duplicateDetection'
  | 'locationInference'
  | 'pictureEnhancement'
  | 'workflows'
  | 'memories';

interface NotificationTypeDescriptor {
  type: NotificationType;
  label: string;
  /** One line explaining what this notification actually tells the user. */
  description: string;
  /**
   * Feature flag this type depends on. When the flag is off the type is HIDDEN
   * — a switch for a notification the deployment can never produce is a dead
   * control, not a preference.
   */
  flag?: FeatureFlagKey;
  /** Delivered to Admins only (#247), so non-admins never see the switch. */
  adminOnly?: boolean;
}

/** State notifications: "N things are waiting for you in a review queue." */
const REVIEW_QUEUE_TYPES: NotificationTypeDescriptor[] = [
  {
    type: 'review_queue_bursts',
    label: 'Burst photos',
    description:
      'Groups of rapid-fire shots detected in your library, waiting for you to pick the keeper.',
    flag: 'burstDetection',
  },
  {
    type: 'review_queue_duplicates',
    label: 'Near-duplicates',
    description:
      'Visually identical re-uploads and re-shares grouped for review before anything is removed.',
    flag: 'duplicateDetection',
  },
  {
    type: 'review_queue_location_suggestions',
    label: 'Location suggestions',
    description:
      'Suggested GPS coordinates for photos that have none, inferred from nearby photos in time.',
    flag: 'locationInference',
  },
  {
    type: 'review_queue_enhancements',
    label: 'AI enhancements',
    description:
      'Finished AI photo enhancements waiting for you to keep, replace, or discard them.',
    flag: 'pictureEnhancement',
  },
];

/** Event notifications: "something just happened." */
const ACTIVITY_TYPES: NotificationTypeDescriptor[] = [
  {
    type: 'upload_completed',
    label: 'Uploads finished',
    description: 'Your uploaded photos and videos have finished processing.',
  },
  {
    type: 'enrichment_failed',
    label: 'Background job failures',
    description:
      'Enrichment jobs are failing and may need attention. Only administrators receive these.',
    adminOnly: true,
  },
  {
    type: 'workflow_run_completed',
    label: 'Workflow runs',
    description:
      'A workflow finished running, including how many items it acted on.',
    flag: 'workflows',
  },
  {
    type: 'share_expiring',
    label: 'Expiring shares',
    description: 'A public share link you created is about to expire.',
  },
  {
    type: 'memories_ready',
    label: 'New memories',
    description:
      'Newly curated memories — On This Day, trips, people and themes — are ready to relive.',
    flag: 'memories',
  },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface NotificationSettingsProps {
  settings: UserSettings;
  updateSettings: (updates: UserSettingsUpdate) => Promise<void>;
  /** Reported to the page's snackbar on a successful save. */
  onSaved?: (message: string) => void;
  /** Page-level save disable (another section is mid-save). */
  disabled?: boolean;
}

export function NotificationSettings({
  settings,
  updateSettings,
  onSaved,
  disabled = false,
}: NotificationSettingsProps) {
  const {
    features,
    pictureEnhancement,
    isLoading: flagsLoading,
    error: flagsError,
  } = useFeatureFlags();
  const { isAdmin } = usePermissions();

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // --- derived state (never a defaulted local object) -----------------------

  const prefs = settings.notifications;
  // `!== false`, not `=== true`: absent means enabled.
  const masterEnabled = prefs?.enabled !== false;
  const typeEnabled = (type: NotificationType): boolean =>
    prefs?.types?.[type] !== false;
  // The one inverted default: absent means OFF.
  const microRunsEnabled = prefs?.workflowMicroRuns === true;

  const isFlagOn = (flag: FeatureFlagKey): boolean => {
    if (flag === 'pictureEnhancement') return pictureEnhancement?.enabled === true;
    return features?.[flag] === true;
  };

  /**
   * Hidden unless the type's feature is known to be ON. A flags outage
   * therefore hides gated switches rather than showing ones that may be dead —
   * the same degrade-to-hidden posture every other gated affordance in the app
   * takes (see `useFeatureFlags`).
   */
  const isVisible = (descriptor: NotificationTypeDescriptor): boolean => {
    if (descriptor.adminOnly && !isAdmin) return false;
    if (descriptor.flag && !isFlagOn(descriptor.flag)) return false;
    return true;
  };

  const visibleReviewQueues = REVIEW_QUEUE_TYPES.filter(isVisible);
  const visibleActivity = ACTIVITY_TYPES.filter(isVisible);
  const workflowRunsVisible = visibleActivity.some(
    (d) => d.type === 'workflow_run_completed',
  );

  // --- saving ---------------------------------------------------------------

  const save = async (patch: NotificationPreferencesPatch, message: string) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      // Only the changed key travels. The API merges per key, so every other
      // preference — including ones this build does not know about — stays
      // exactly as stored, and untouched keys stay ABSENT.
      await updateSettings({ notifications: patch });
      onSaved?.(message);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Failed to save notification preferences',
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleMasterToggle = (next: boolean) =>
    void save(
      { enabled: next },
      next ? 'Notifications turned on' : 'Notifications turned off',
    );

  const handleTypeToggle = (type: NotificationType, next: boolean) =>
    // Re-enabling DELETES the override (null) instead of writing `true`, so the
    // key returns to absent and the type follows the default again.
    void save({ types: { [type]: next ? null : false } }, 'Notification preferences updated');

  const handleMicroRunsToggle = (next: boolean) =>
    void save({ workflowMicroRuns: next }, 'Notification preferences updated');

  const controlsDisabled = disabled || isSaving;

  // --- rendering ------------------------------------------------------------

  const renderTypeSwitch = (descriptor: NotificationTypeDescriptor) => (
    <Box key={descriptor.type} sx={{ mb: 2 }}>
      <FormControlLabel
        control={
          <Switch
            checked={typeEnabled(descriptor.type)}
            onChange={(e) => handleTypeToggle(descriptor.type, e.target.checked)}
            disabled={controlsDisabled || !masterEnabled}
            slotProps={{
              input: { 'aria-label': `${descriptor.label} notifications` },
            }}
          />
        }
        label={descriptor.label}
        sx={{ display: 'block', minHeight: 44, ml: 0 }}
      />
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ ml: { xs: 0, sm: 6 } }}
      >
        {descriptor.description}
      </Typography>

      {descriptor.type === 'workflow_run_completed' && (
        <Box sx={{ ml: { xs: 2, sm: 6 }, mt: 1 }}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={microRunsEnabled}
                onChange={(e) => handleMicroRunsToggle(e.target.checked)}
                disabled={
                  controlsDisabled ||
                  !masterEnabled ||
                  !typeEnabled('workflow_run_completed')
                }
                slotProps={{
                  input: { 'aria-label': 'Automatic per-upload workflow runs' },
                }}
              />
            }
            label="Also notify me about automatic per-upload runs"
            sx={{ display: 'block', minHeight: 44, ml: 0 }}
          />
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ ml: { xs: 0, sm: 5 } }}
          >
            Off by default. Workflows that trigger on newly-uploaded media fire
            continuously during an import, so these runs are kept quiet unless you
            ask for them.
          </Typography>
        </Box>
      )}
    </Box>
  );

  return (
    <Card id="notifications">
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Notifications
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Choose what you are notified about in the notification bell. Everything
          is on unless you turn it off here.
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          Turning a notification type off also dismisses the notifications of that
          type you already have — they are cleared from your bell, not just
          stopped going forward.
        </Alert>

        <FormControlLabel
          control={
            <Switch
              checked={masterEnabled}
              onChange={(e) => handleMasterToggle(e.target.checked)}
              disabled={controlsDisabled}
              slotProps={{ input: { 'aria-label': 'All notifications' } }}
            />
          }
          label="Enable notifications"
          sx={{ display: 'block', minHeight: 44, ml: 0 }}
        />
        <Typography variant="body2" color="text.secondary" sx={{ ml: { xs: 0, sm: 6 } }}>
          Master switch. When off, nothing below can notify you, and your existing
          notifications are dismissed.
        </Typography>

        {flagsError && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            Couldn&apos;t check which features are enabled for this deployment, so
            some notification types are hidden. Reload to try again.
          </Alert>
        )}

        {flagsLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          <>
            {visibleReviewQueues.length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
                  Review queues
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  A running count of items waiting for a decision. Only the queues
                  enabled on this deployment are listed.
                </Typography>
                {visibleReviewQueues.map(renderTypeSwitch)}
              </>
            )}

            {visibleActivity.length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
                  Activity
                </Typography>
                {visibleActivity.map(renderTypeSwitch)}
              </>
            )}

            {visibleReviewQueues.length === 0 && visibleActivity.length === 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="body2" color="text.secondary">
                  No notification types are available on this deployment.
                </Typography>
              </>
            )}
          </>
        )}

        {/* The micro-runs sub-option is rendered UNDER `workflow_run_completed`,
            so hiding that type hides the sub-option with it. If the user had
            already opted in, say so rather than leaving a stored preference
            that silently has nowhere to appear. */}
        {!workflowRunsVisible && microRunsEnabled && !flagsLoading && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            Per-upload workflow run notifications are still enabled in your
            preferences, but workflow automation is off for this deployment.
          </Typography>
        )}

        {saveError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {saveError}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
