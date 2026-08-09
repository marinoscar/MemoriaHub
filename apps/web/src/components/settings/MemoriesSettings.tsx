// ---------------------------------------------------------------------------
// MemoriesSettings — per-user memory preferences (epic #300, issue #313)
//
// THE ABSENT-KEY CONTRACT (read before editing — same rule as
// `NotificationSettings`, and just as load-bearing)
// -------------------------------------------------------------------------
// `user_settings.memories` is stored SPARSELY. An absent namespace, an absent
// `hiddenPersonIds`, an absent `hiddenDateRanges` and an absent
// `emailDigestOptOut` all mean "no preference": nobody hidden, no sensitive
// window, digest ON. That is what let the namespace ship without a migration,
// and it is why this component:
//
//   * DERIVES every control from `settings.memories` — there is no defaulted
//     local mirror that could be written back and pin the user to today's
//     defaults;
//   * PATCHes exactly the one key it changed, never a materialized namespace;
//   * CLEARS a key by sending `null` (a JSON Merge Patch delete) rather than
//     `[]` / `false`, so removing your last hidden person returns you to the
//     absent state instead of storing an empty array forever.
//
// WHY THE DATE PICKERS ARE NATIVE
// -------------------------------
// `@mui/x-date-pickers` is not a dependency of this app, and `SharePanel`
// already establishes native date inputs as the precedent. A native
// `<input type="date">` also emits exactly `YYYY-MM-DD`, which is verbatim what
// `memoriesHiddenDateRangeSchema` accepts — a picker returning a Date object
// would need a formatting step whose only possible contribution is a timezone
// bug (a `toISOString()` on a local midnight silently shifts the day).
//
// WHY DATE RANGES HAVE A SAVE BUTTON AND THE OTHER TWO DO NOT
// -----------------------------------------------------------
// A switch and a chip removal are complete gestures — the moment they happen,
// the user's intent is unambiguous, so they save immediately (one-key delta,
// same reasoning as the notification switches). A date range is INCOMPLETE
// until both bounds are filled and `from <= to`; saving keystroke-by-keystroke
// would PATCH a half-typed year and be rejected by the API. So ranges are
// edited locally and committed explicitly, with the dirty state visible.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import type { SyntheticEvent } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  DeleteOutlined as DeleteOutlineIcon,
} from '@mui/icons-material';

import { useCircle } from '../../hooks/useCircle';
import { useMemoriesEnabled } from '../../hooks/useMemoriesEnabled';
import { usePeople } from '../../hooks/usePeople';
import { PersonAvatar } from '../people/PersonAvatar';
import type { PersonListItem } from '../../services/face';
import type { UserSettings, UserSettingsUpdate } from '../../types';
import type { MemoryHiddenDateRange } from '../../types/memories';
import {
  MEMORIES_MAX_HIDDEN_DATE_RANGES,
  MEMORIES_MAX_HIDDEN_PERSON_IDS,
} from '../../types/memories';

interface MemoriesSettingsProps {
  settings: UserSettings;
  updateSettings: (updates: UserSettingsUpdate) => Promise<void>;
  /** Reported to the page's snackbar on a successful save. */
  onSaved?: (message: string) => void;
  /** Page-level save disable (another section is mid-save). */
  disabled?: boolean;
}

/** A row being edited. Bounds may be blank while the user is still typing. */
interface DraftRange {
  key: string;
  from: string;
  to: string;
}

let draftKeySeed = 0;
const nextDraftKey = () => `range-${(draftKeySeed += 1)}`;

function toDrafts(ranges: MemoryHiddenDateRange[] | undefined): DraftRange[] {
  return (ranges ?? []).map((range) => ({ key: nextDraftKey(), ...range }));
}

/** A row is committable only when both bounds are present and ordered. */
function isCompleteRange(draft: DraftRange): boolean {
  return draft.from !== '' && draft.to !== '' && draft.from <= draft.to;
}

export function MemoriesSettings({
  settings,
  updateSettings,
  onSaved,
  disabled = false,
}: MemoriesSettingsProps) {
  const enabled = useMemoriesEnabled();
  const { activeCircleId } = useCircle();

  // The flag is threaded INTO the hook, not wrapped around the component: with
  // memories off this section renders nothing AND fires no people request.
  const { data: people, loading: peopleLoading } = usePeople(
    enabled === true ? activeCircleId : null,
  );

  const prefs = settings.memories;
  const hiddenPersonIds = useMemo(() => prefs?.hiddenPersonIds ?? [], [prefs]);
  const storedRanges = prefs?.hiddenDateRanges;
  const digestOptOut = prefs?.emailDigestOptOut === true;

  const [drafts, setDrafts] = useState<DraftRange[]>(() => toDrafts(storedRanges));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed the local draft list whenever the SERVER's copy changes — a
  // successful save returns the persisted settings, and a stale local list
  // would then quietly disagree with what is stored.
  const storedSignature = JSON.stringify(storedRanges ?? []);
  useEffect(() => {
    setDrafts(toDrafts(storedRanges));
    // Compared by value: the array identity changes on every settings refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedSignature]);

  const save = async (
    patch: NonNullable<UserSettingsUpdate['memories']>,
    message: string,
  ) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateSettings({ memories: patch });
      onSaved?.(message);
      return true;
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Failed to save memory preferences',
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  // Feature off, or flags still resolving: render nothing at all. A preferences
  // panel for a feature that cannot produce anything is dead UI, and gating on
  // `=== true` keeps it from flashing in while the flags load.
  if (enabled !== true) return null;

  const controlsDisabled = disabled || isSaving;

  const options: PersonListItem[] = (people?.items ?? []).filter(
    (person) => person.name != null,
  );
  const selectedPeople = hiddenPersonIds
    .map((id) => options.find((person) => person.id === id))
    .filter((person): person is PersonListItem => person != null);
  /**
   * Ids stored but not present in the current circle's people list — the
   * preference is app-wide while the picker can only show ONE circle, and a
   * person may also have been deleted or merged since. They are surfaced as
   * plain removable chips rather than dropped, because silently discarding them
   * on the next save would un-hide somebody the user asked to hide.
   */
  const unresolvedIds = hiddenPersonIds.filter(
    (id) => !options.some((person) => person.id === id),
  );

  const handlePeopleChange = (_: SyntheticEvent, value: PersonListItem[]) => {
    // The picker only ever knows about THIS circle's people, so the ids it
    // cannot see are preserved explicitly rather than by omission.
    const next = [...value.map((person) => person.id), ...unresolvedIds];
    void save(
      { hiddenPersonIds: next.length > 0 ? next : null },
      'Hidden people updated',
    );
  };

  const removeUnresolved = (id: string) => {
    const next = hiddenPersonIds.filter((value) => value !== id);
    void save(
      { hiddenPersonIds: next.length > 0 ? next : null },
      'Hidden people updated',
    );
  };

  const completeRanges = drafts.filter(isCompleteRange);
  const invalidRange = drafts.some(
    (draft) => draft.from !== '' && draft.to !== '' && draft.from > draft.to,
  );
  const incompleteRange = drafts.some(
    (draft) => (draft.from === '') !== (draft.to === ''),
  );
  const rangesDirty =
    JSON.stringify(completeRanges.map(({ from, to }) => ({ from, to }))) !==
    storedSignature;

  const saveRanges = () => {
    const payload = completeRanges.map(({ from, to }) => ({ from, to }));
    void save(
      { hiddenDateRanges: payload.length > 0 ? payload : null },
      'Hidden dates updated',
    ).then((ok) => {
      // Drop any half-filled row the user abandoned, so the list on screen is
      // exactly what is now stored.
      if (ok) setDrafts(toDrafts(payload));
    });
  };

  return (
    <Card id="memories">
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Memories
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          MemoriaHub curates memories automatically — trips, people, themes and
          “on this day” moments. These settings decide what it may never resurface
          for you.
        </Typography>

        {/* ---------------------------------------------------------------- */}
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          Hide people
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Memories about these people are never shown to you. Other members of the
          circle are unaffected, and nothing is deleted — their photos stay in the
          library, in albums and in search.
        </Typography>

        <Autocomplete<PersonListItem, true, false, false>
          multiple
          disabled={controlsDisabled || peopleLoading}
          options={options}
          value={selectedPeople}
          onChange={handlePeopleChange}
          getOptionLabel={(person) => person.name ?? person.id.slice(0, 8)}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          renderOption={(props, person) => {
            const { key, ...rest } = props as { key?: string } & Record<string, unknown>;
            return (
              <Box
                component="li"
                key={key}
                {...rest}
                sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
              >
                <PersonAvatar person={person} size={28} />
                <Typography variant="body2">
                  {person.name ?? person.id.slice(0, 8)}
                </Typography>
              </Box>
            );
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="People to hide"
              size="small"
              placeholder={selectedPeople.length === 0 ? 'Search people…' : undefined}
              helperText={
                hiddenPersonIds.length >= MEMORIES_MAX_HIDDEN_PERSON_IDS
                  ? `You can hide at most ${MEMORIES_MAX_HIDDEN_PERSON_IDS} people.`
                  : ' '
              }
            />
          )}
        />

        {unresolvedIds.length > 0 && (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1 }}>
            {unresolvedIds.map((id) => (
              <Tooltip
                key={id}
                title="Hidden in another circle, or the person has since been removed"
              >
                <Chip
                  size="small"
                  variant="outlined"
                  label={id.slice(0, 8)}
                  onDelete={controlsDisabled ? undefined : () => removeUnresolved(id)}
                />
              </Tooltip>
            ))}
          </Stack>
        )}

        <Divider sx={{ my: 3 }} />

        {/* ---------------------------------------------------------------- */}
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          Hide dates
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Memories overlapping these dates will never be shown to you. Both days
          are included.
        </Typography>

        <Stack spacing={1.5}>
          {drafts.map((draft, position) => {
            const ordered = draft.from === '' || draft.to === '' || draft.from <= draft.to;
            return (
              <Stack
                key={draft.key}
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                sx={{ alignItems: { sm: 'flex-start' } }}
              >
                <TextField
                  type="date"
                  size="small"
                  label="From"
                  value={draft.from}
                  disabled={controlsDisabled}
                  onChange={(e) =>
                    setDrafts((prev) =>
                      prev.map((row, i) =>
                        i === position ? { ...row, from: e.target.value } : row,
                      ),
                    )
                  }
                  slotProps={{ inputLabel: { shrink: true } }}
                  error={!ordered}
                />
                <TextField
                  type="date"
                  size="small"
                  label="To"
                  value={draft.to}
                  disabled={controlsDisabled}
                  onChange={(e) =>
                    setDrafts((prev) =>
                      prev.map((row, i) =>
                        i === position ? { ...row, to: e.target.value } : row,
                      ),
                    )
                  }
                  slotProps={{ inputLabel: { shrink: true } }}
                  error={!ordered}
                  helperText={ordered ? undefined : 'The start date must not be after the end date.'}
                />
                <IconButton
                  aria-label={`Remove date range ${position + 1}`}
                  disabled={controlsDisabled}
                  onClick={() =>
                    setDrafts((prev) => prev.filter((_, i) => i !== position))
                  }
                >
                  <DeleteOutlineIcon />
                </IconButton>
              </Stack>
            );
          })}
        </Stack>

        <Stack direction="row" spacing={1} sx={{ mt: drafts.length > 0 ? 2 : 0 }}>
          <Button
            size="small"
            startIcon={<AddIcon />}
            disabled={
              controlsDisabled || drafts.length >= MEMORIES_MAX_HIDDEN_DATE_RANGES
            }
            onClick={() =>
              setDrafts((prev) => [...prev, { key: nextDraftKey(), from: '', to: '' }])
            }
          >
            Add date range
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={controlsDisabled || !rangesDirty || invalidRange}
            onClick={saveRanges}
          >
            Save dates
          </Button>
        </Stack>

        {incompleteRange && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            A range needs both a start and an end date before it can be saved.
          </Typography>
        )}
        {drafts.length >= MEMORIES_MAX_HIDDEN_DATE_RANGES && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            You can hide at most {MEMORIES_MAX_HIDDEN_DATE_RANGES} date ranges.
          </Typography>
        )}

        <Divider sx={{ my: 3 }} />

        {/* ---------------------------------------------------------------- */}
        <FormControlLabel
          control={
            <Switch
              // Stored INVERTED: the setting is an opt-OUT, the control is an
              // opt-IN, so the absent-means-subscribed default reads correctly
              // as "on" for everyone who has never touched this.
              checked={!digestOptOut}
              disabled={controlsDisabled}
              onChange={(e) =>
                void save(
                  // Re-subscribing DELETES the key rather than writing `false`,
                  // returning the user to the default instead of pinning them.
                  { emailDigestOptOut: e.target.checked ? null : true },
                  e.target.checked
                    ? 'Memory digest emails turned on'
                    : 'Memory digest emails turned off',
                )
              }
              slotProps={{ input: { 'aria-label': 'Email me memory digests' } }}
            />
          }
          label="Email me memory digests"
          sx={{ display: 'block', minHeight: 44, ml: 0 }}
        />
        <Typography variant="body2" color="text.secondary" sx={{ ml: { xs: 0, sm: 6 } }}>
          A periodic email with your circle&apos;s newest memories. It is only sent
          when there is something new, and an administrator may have turned digests
          off for the whole installation.
        </Typography>

        {saveError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {saveError}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
