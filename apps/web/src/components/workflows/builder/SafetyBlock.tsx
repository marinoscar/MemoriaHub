import { useEffect } from 'react';
import {
  Stack,
  TextField,
  FormControlLabel,
  Switch,
  Typography,
  Box,
} from '@mui/material';
import { BuilderBlock } from './BuilderBlock';
import type { BuilderAction } from '../../../pages/Workflows/builderState';

interface SafetyBlockProps {
  maxItems: number | undefined;
  requirePreview: boolean | undefined;
  /** System-wide per-run cap (workflows.maxItemsPerRun). */
  systemCap: number;
  /** True when the system requires preview+approval (workflows.requirePreview). */
  systemRequiresPreview: boolean;
  /** True when a gated action (hard_delete) is present — forces preview ON. */
  hasGatedAction: boolean;
  dispatch: (action: BuilderAction) => void;
}

// ---------------------------------------------------------------------------
// SafetyBlock — a per-workflow max-items cap (bounded by, and showing, the
// system cap) and a require-preview toggle (locked ON when the system requires
// it or a gated action is present). Persisted into definition.options.
// ---------------------------------------------------------------------------

export function SafetyBlock({
  maxItems,
  requirePreview,
  systemCap,
  systemRequiresPreview,
  hasGatedAction,
  dispatch,
}: SafetyBlockProps) {
  const previewLocked = systemRequiresPreview || hasGatedAction;
  const effectiveRequirePreview = previewLocked ? true : requirePreview ?? true;

  // Keep the persisted flag consistent with the lock.
  useEffect(() => {
    if (previewLocked && requirePreview !== true) {
      dispatch({ kind: 'setRequirePreview', value: true });
    }
  }, [previewLocked, requirePreview, dispatch]);

  const overCap = maxItems !== undefined && maxItems > systemCap;

  return (
    <BuilderBlock
      keyword="SAFETY"
      title="Safety limits"
      subtitle="Bound how much a single run can touch, and require a preview before it runs."
      color="warning"
    >
      <Stack spacing={2.5}>
        <Box>
          <TextField
            label="Max items per run (optional)"
            type="number"
            size="small"
            value={maxItems ?? ''}
            onChange={(e) =>
              dispatch({
                kind: 'setMaxItems',
                value: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)),
              })
            }
            error={overCap}
            helperText={
              overCap
                ? `Exceeds the system cap of ${systemCap.toLocaleString()}; the run is limited to ${systemCap.toLocaleString()}.`
                : `Leave blank to use the system cap of ${systemCap.toLocaleString()}.`
            }
            slotProps={{ htmlInput: { min: 1, max: systemCap } }}
            sx={{ maxWidth: 340 }}
          />
        </Box>

        <Box>
          <FormControlLabel
            control={
              <Switch
                checked={effectiveRequirePreview}
                disabled={previewLocked}
                onChange={(e) =>
                  dispatch({ kind: 'setRequirePreview', value: e.target.checked })
                }
              />
            }
            label="Require a preview + approval before this workflow runs"
          />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {hasGatedAction
              ? 'Locked on — a permanent-delete action always requires a reviewed preview.'
              : systemRequiresPreview
                ? 'Locked on by the system settings for all workflows.'
                : 'When on, manual runs pause for you to review the matched items before applying.'}
          </Typography>
        </Box>
      </Stack>
    </BuilderBlock>
  );
}
