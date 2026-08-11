/**
 * MergeLocationsDialog — merge many selected location values into one group.
 *
 * Issue #407. Shared verbatim by the two surfaces that can produce a
 * multi-value selection:
 *   - `/places/countries|regions|cities` (LevelBrowsePage select mode) — merge
 *     in context, where the user is actually LOOKING at three Heredia tiles.
 *   - Admin > Location Groups > "All locations" — merge from the flat,
 *     paginated list of every raw geocoder value.
 *
 * It owns none of the selection: the caller keeps it, so a 409 can leave it
 * intact for the user to untick the offending value and retry.
 *
 * ⚠️ The 409 owner is read from `details.groupName` via
 * `extractLocationGroupConflict()`, never a top-level field — the API's
 * `HttpExceptionFilter` rebuilds every error body from a fixed key allowlist
 * and silently drops unknown top-level keys (see the 409 gotcha in CLAUDE.md).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  extractLocationGroupConflict,
  listLocationGroups,
  locationGroupErrorMessage,
  mergeLocationGroups,
} from '../../services/locationGroups';
import type {
  LocationGroupLevel,
  LocationGroupSummary,
  MergeLocationGroupsResult,
} from '../../services/locationGroups';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** One selected location, as either surface knows it. */
export interface MergeLocationCandidate {
  /**
   * The member value submitted to the API. On `/places` this is the tile's
   * DISPLAYED (canonical) name — for an ungrouped value canonical equals raw,
   * so it is the right thing to send; a value that is already a group comes
   * back as a 409, which is surfaced rather than special-cased.
   */
  value: string;
  /** Photo count — drives the name prefill and the preview line. */
  itemCount: number;
  /** ISO country scope when the surface knows one. */
  countryCode?: string | null;
  /** Group that already claims this value, when known up front. */
  groupCanonicalName?: string | null;
}

export interface MergeLocationsDialogProps {
  open: boolean;
  /** Tier the merge targets — decides which groups the picker offers. */
  level: LocationGroupLevel;
  /** The caller's current selection. Never mutated here. */
  selection: MergeLocationCandidate[];
  /**
   * Country scope to submit unconditionally, bypassing derivation from the
   * selection. `''` is the deliberate UNSCOPED sentinel and is what the region
   * and city tiers of `/places` pass, because
   * `GET /api/media/explore/locations/:level` aggregates those tiers across
   * countries and never carries a code. Omit (or `null`) to derive the scope
   * from the candidates instead.
   */
  forcedCountryCode?: string | null;
  onClose: () => void;
  /** Fired once the merge succeeds; the caller clears its selection here. */
  onMerged: (result: MergeLocationGroupsResult) => void;
}

const LEVEL_LABEL: Record<LocationGroupLevel, string> = {
  country: 'country',
  region: 'region',
  locality: 'city',
};

type TargetMode = 'create' | 'existing';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MergeLocationsDialog({
  open,
  level,
  selection,
  forcedCountryCode,
  onClose,
  onMerged,
}: MergeLocationsDialogProps) {
  const [mode, setMode] = useState<TargetMode>('create');
  const [canonicalName, setCanonicalName] = useState('');
  const [targetGroup, setTargetGroup] = useState<LocationGroupSummary | null>(null);
  const [groups, setGroups] = useState<LocationGroupSummary[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [unscopedAcknowledged, setUnscopedAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictGroupName, setConflictGroupName] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Derived selection facts
  // -------------------------------------------------------------------------

  const totalItems = useMemo(
    () => selection.reduce((sum, c) => sum + (c.itemCount || 0), 0),
    [selection],
  );

  /** The selected value with the most photos — the name prefill. */
  const dominantValue = useMemo(() => {
    if (selection.length === 0) return '';
    return selection.reduce((best, c) => (c.itemCount > best.itemCount ? c : best)).value;
  }, [selection]);

  /** Distinct non-blank country codes present across the selection. */
  const distinctCountryCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const c of selection) {
      const code = (c.countryCode ?? '').trim();
      if (code) codes.add(code);
    }
    return Array.from(codes);
  }, [selection]);

  /**
   * The scope the merge will submit, plus whether it needs an explicit
   * acknowledgement first. A selection spanning two countries is NEVER
   * resolved by silently picking one — the user is asked.
   */
  const scope = useMemo(() => {
    if (forcedCountryCode != null) {
      return { countryCode: forcedCountryCode, mixed: false, countryCount: 0 };
    }
    if (distinctCountryCodes.length > 1) {
      return { countryCode: '', mixed: true, countryCount: distinctCountryCodes.length };
    }
    return { countryCode: distinctCountryCodes[0] ?? '', mixed: false, countryCount: 0 };
  }, [forcedCountryCode, distinctCountryCodes]);

  // -------------------------------------------------------------------------
  // Reset on open
  // -------------------------------------------------------------------------

  /**
   * Seed the form each time the dialog opens. `dominantValue` is a plain
   * string, so this re-runs only when the prefill genuinely differs — not on
   * every parent re-render that hands over a new array identity.
   */
  useEffect(() => {
    if (!open) return;
    setMode('create');
    setCanonicalName(dominantValue);
    setTargetGroup(null);
    setUnscopedAcknowledged(false);
    setSubmitting(false);
    setError(null);
    setConflictGroupName(null);
  }, [open, dominantValue]);

  // Existing-group picker options for this tier.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setGroupsLoading(true);
    listLocationGroups({ level, page: 1, pageSize: 200 })
      .then((res) => {
        if (!cancelled) setGroups(res.items);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      })
      .finally(() => {
        if (!cancelled) setGroupsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, level]);

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  const targetName =
    mode === 'existing' ? (targetGroup?.canonicalName ?? '') : canonicalName.trim();

  /**
   * A mixed-country selection only needs a decision when a NEW group is being
   * created: merging into an existing group inherits that group's own scope,
   * so there is nothing for the user to choose.
   */
  const needsUnscopedConsent = scope.mixed && mode === 'create';

  const canSubmit =
    selection.length > 0 &&
    !submitting &&
    (mode === 'existing' ? !!targetGroup : !!canonicalName.trim()) &&
    (!needsUnscopedConsent || unscopedAcknowledged);

  const handleMerge = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    setConflictGroupName(null);
    try {
      const result = await mergeLocationGroups({
        level,
        values: selection.map((c) => c.value),
        // Adding to an existing group deliberately sends NO countryCode: the
        // target's own scope governs, and a non-empty code that disagreed with
        // it would be a 400 the user could do nothing about.
        ...(mode === 'existing' && targetGroup
          ? { targetGroupId: targetGroup.id }
          : { countryCode: scope.countryCode, canonicalName: canonicalName.trim() }),
      });
      onMerged(result);
      onClose();
    } catch (err: unknown) {
      // Keep the dialog open AND the caller's selection intact so the user can
      // untick the offending value and retry.
      const conflict = extractLocationGroupConflict(err);
      setConflictGroupName(conflict?.groupName ?? null);
      setError(locationGroupErrorMessage(err, 'Failed to merge the selected locations'));
    } finally {
      setSubmitting(false);
    }
  }, [level, scope.countryCode, selection, mode, targetGroup, canonicalName, onMerged, onClose]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Merge locations</DialogTitle>
      <DialogContent dividers sx={{ overflowX: 'hidden' }}>
        <Stack spacing={2.5} sx={{ minWidth: 0 }}>
          {error && (
            <Alert severity={conflictGroupName ? 'warning' : 'error'} onClose={() => setError(null)}>
              {/* `locationGroupErrorMessage` already names the owning group from
                  `details.groupName`; keep the API's own wording — it says WHICH
                  value conflicted — and only add the action. */}
              {error}
              {conflictGroupName && ' Untick it and try again.'}
            </Alert>
          )}

          {/* Selected values ------------------------------------------------ */}
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Selected locations
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {selection.map((candidate) => (
                <Chip
                  key={candidate.value}
                  size="small"
                  label={`${candidate.value} (${candidate.itemCount.toLocaleString()})`}
                  color={
                    conflictGroupName && candidate.groupCanonicalName === conflictGroupName
                      ? 'warning'
                      : 'default'
                  }
                />
              ))}
            </Box>
          </Box>

          {/* Target --------------------------------------------------------- */}
          <FormControl>
            <FormLabel id="merge-target-label">Merge into</FormLabel>
            <RadioGroup
              aria-labelledby="merge-target-label"
              value={mode}
              onChange={(e) => setMode(e.target.value as TargetMode)}
            >
              <FormControlLabel
                value="create"
                control={<Radio size="small" />}
                label="A new group"
              />
              <FormControlLabel
                value="existing"
                control={<Radio size="small" />}
                label="An existing group"
              />
            </RadioGroup>
          </FormControl>

          {mode === 'create' ? (
            <TextField
              label="Canonical name"
              size="small"
              fullWidth
              value={canonicalName}
              onChange={(e) => setCanonicalName(e.target.value)}
              helperText={`The display name every selected ${LEVEL_LABEL[level]} collapses into.`}
            />
          ) : (
            <Autocomplete
              options={groups}
              loading={groupsLoading}
              value={targetGroup}
              onChange={(_, next) => setTargetGroup(next)}
              getOptionLabel={(option) => option.canonicalName}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              renderInput={(params) => (
                <TextField
                  {...params}
                  size="small"
                  label="Existing group"
                  helperText="The group keeps its current name; the selected values are added to it."
                />
              )}
            />
          )}

          {/* Mixed-country prompt ------------------------------------------- */}
          {needsUnscopedConsent && (
            <Alert severity="warning">
              <Typography variant="body2" sx={{ mb: 1 }}>
                These locations span {scope.countryCount} countries — make this group apply in every
                country?
              </Typography>
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={unscopedAcknowledged}
                    onChange={(e) => setUnscopedAcknowledged(e.target.checked)}
                  />
                }
                label="Apply in every country"
              />
            </Alert>
          )}

          {/* Preview -------------------------------------------------------- */}
          <Typography variant="body2" color="text.secondary" data-testid="merge-preview">
            {selection.length.toLocaleString()} location{selection.length === 1 ? '' : 's'} ·{' '}
            {totalItems.toLocaleString()} photo{totalItems === 1 ? '' : 's'} will be grouped as{' '}
            <Box component="em">{targetName || '…'}</Box>
          </Typography>

          <Typography variant="caption" color="text.secondary">
            Merging queues a rebuild — browse surfaces keep showing the old names until it
            finishes.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => void handleMerge()}
          disabled={!canSubmit}
          startIcon={submitting ? <CircularProgress size={16} /> : undefined}
        >
          Merge
        </Button>
      </DialogActions>
    </Dialog>
  );
}
