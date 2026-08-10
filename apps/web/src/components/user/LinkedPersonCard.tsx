import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { LinkOff as LinkOffIcon } from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import { usePermissions } from '../../hooks/usePermissions';
import { PersonAvatar } from '../people/PersonAvatar';
import { listPeople } from '../../services/face';
import type { PersonListItem } from '../../services/face';
import type { UserProfile } from '../../services/userProfile';

/**
 * Rows per request. This is the API's hard cap (`listPeopleQuerySchema` in
 * `apps/api/src/face/dto/people.dto.ts` rejects anything above 100) — asking
 * for more is a 400, not a larger page.
 */
const PEOPLE_PAGE_SIZE = 100;

/**
 * Ceiling on people loaded per circle across all pages. The Autocomplete
 * filters client-side, so stopping at one page would let a user search only the
 * first 100 names and quietly conclude the person does not exist.
 */
const PEOPLE_MAX_PER_CIRCLE = 500;

interface PersonOption {
  person: PersonListItem;
  circleId: string;
  circleName: string;
  /** Pre-resolved label so Autocomplete's default filter can match on it. */
  label: string;
}

/**
 * Every person in one circle, paged at the API's cap and bounded by
 * `PEOPLE_MAX_PER_CIRCLE`. Stops as soon as the server reports the last page,
 * so the common single-page circle still costs exactly one request.
 */
async function loadCirclePeople(circleId: string): Promise<PersonListItem[]> {
  const items: PersonListItem[] = [];
  let page = 1;
  for (;;) {
    const resp = await listPeople(circleId, {
      page,
      pageSize: PEOPLE_PAGE_SIZE,
    });
    items.push(...resp.items);
    if (
      resp.items.length === 0 ||
      page >= resp.meta.totalPages ||
      items.length >= PEOPLE_MAX_PER_CIRCLE
    ) {
      return items;
    }
    page += 1;
  }
}

interface LinkedPersonCardProps {
  profile: UserProfile;
  /** `null` unlinks. Resolves once the PATCH has been applied. */
  onLinkChange: (personId: string | null) => Promise<void>;
  disabled?: boolean;
}

/**
 * Pick the `Person` this account represents, across every circle the user
 * belongs to.
 *
 * Three distinct empty states, because each one needs a different action from
 * the user and collapsing them into one "nothing here" would tell them nothing:
 *
 *  1. Face recognition is off globally  → an admin has to turn it on.
 *  2. It is on, but no people exist yet → upload photos and wait for detection.
 *  3. People exist                      → the picker.
 *
 * The flag comes from `GET /api/features` (authenticated, any role) rather than
 * `GET /api/system-settings`, which is Admin-gated and would 403 for the
 * ordinary circle member this page mostly serves.
 */
export function LinkedPersonCard({
  profile,
  onLinkChange,
  disabled = false,
}: LinkedPersonCardProps) {
  const { circles, activeCircleId } = useCircle();
  const { features, isLoading: flagsLoading } = useFeatureFlags();
  const { isAdmin } = usePermissions();

  const [people, setPeople] = useState<PersonOption[] | null>(null);
  const [loadingPeople, setLoadingPeople] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PersonOption | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const faceRecognitionEnabled = features?.faceRecognition === true;
  // Tolerate a brand-new install: zero circles is a legitimate state, not a bug.
  const hasCircles = circles.length > 0;

  const loadPeople = useCallback(async () => {
    setLoadingPeople(true);
    setLoadError(null);
    try {
      // One request per circle, tolerated individually: a single circle failing
      // (e.g. a permission edge) must not blank out the whole picker.
      const results = await Promise.allSettled(
        circles.map((circle) => loadCirclePeople(circle.id)),
      );

      const collected: PersonOption[] = [];
      let firstFailure: unknown = null;
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          if (firstFailure === null) firstFailure = result.reason;
          continue;
        }
        const circle = circles[index];
        for (const person of result.value) {
          collected.push({
            person,
            circleId: circle.id,
            circleName: circle.name,
            label: person.name ?? 'Unnamed person',
          });
        }
      }

      setPeople(collected);
      if (firstFailure !== null && collected.length === 0) {
        // Surface what actually failed. The previous hard-coded string hid an
        // API validation error behind an unactionable "Failed to load people."
        setLoadError(
          firstFailure instanceof Error
            ? `Failed to load people: ${firstFailure.message}`
            : 'Failed to load people.',
        );
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load people');
      setPeople([]);
    } finally {
      setLoadingPeople(false);
    }
  }, [circles]);

  useEffect(() => {
    if (!faceRecognitionEnabled || !hasCircles) {
      setPeople(null);
      return;
    }
    void loadPeople();
  }, [faceRecognitionEnabled, hasCircles, loadPeople]);

  /**
   * Active circle first, then alphabetically. Sorting at render rather than at
   * fetch keeps switching circles from re-issuing every people request.
   */
  const options = useMemo(() => {
    if (!people) return null;
    return [...people].sort((a, b) => {
      if (a.circleId !== b.circleId) {
        if (a.circleId === activeCircleId) return -1;
        if (b.circleId === activeCircleId) return 1;
        return a.circleName.localeCompare(b.circleName);
      }
      return a.label.localeCompare(b.label);
    });
  }, [people, activeCircleId]);

  /**
   * The API's `linkedPerson` carries only id/name/circle, so borrow the full
   * record from the loaded list when we have it — that is what gives the linked
   * person a real face crop instead of the generic silhouette.
   */
  const linkedPersonRecord = useMemo((): PersonListItem | null => {
    const linked = profile.linkedPerson;
    if (!linked) return null;
    const match = people?.find((o) => o.person.id === linked.id);
    if (match) return match.person;
    return {
      id: linked.id,
      name: linked.name,
      isUnlabeled: linked.name === null,
      faceCount: 0,
      coverFace: null,
      profileMediaItemId: null,
      profileCrop: null,
      createdAt: '',
      updatedAt: '',
      favorite: false,
    };
  }, [profile.linkedPerson, people]);

  const handleLink = async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      await onLinkChange(selected.person.id);
      setSelected(null);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnlink = async () => {
    setSubmitting(true);
    try {
      await onLinkChange(null);
    } finally {
      setSubmitting(false);
    }
  };

  const busy = disabled || submitting;

  // -------------------------------------------------------------------------
  // Body — the three empty states, then the picker
  // -------------------------------------------------------------------------
  const renderBody = () => {
    if (flagsLoading) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      );
    }

    // (1) Feature off globally.
    if (!faceRecognitionEnabled) {
      return (
        <Alert severity="info">
          Face recognition is turned off, so there are no people to link to.{' '}
          {isAdmin ? (
            <>
              Enable it in{' '}
              <Link component={RouterLink} to="/admin/settings/face">
                Admin → Settings → Face
              </Link>
              .
            </>
          ) : (
            'Ask an administrator to enable it in Admin → Settings → Face.'
          )}
        </Alert>
      );
    }

    // Zero circles — a brand-new account. Not one of the three named states,
    // but it must render something rather than an endless spinner.
    if (!hasCircles) {
      return (
        <Alert severity="info">
          You are not a member of any circle yet, so there are no people to link
          to.{' '}
          <Link component={RouterLink} to="/circles">
            Create or join a circle
          </Link>{' '}
          to get started.
        </Alert>
      );
    }

    if (loadingPeople && options === null) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      );
    }

    if (loadError) {
      return <Alert severity="error">{loadError}</Alert>;
    }

    // (2) Enabled, but nothing detected yet.
    if (!options || options.length === 0) {
      return (
        <Alert severity="info">
          No people found yet. Upload photos and MemoriaHub will detect faces
          automatically.
        </Alert>
      );
    }

    // (3) The picker.
    return (
      <Stack spacing={2}>
        <Autocomplete
          options={options}
          value={selected}
          onChange={(_e, value) => setSelected(value)}
          disabled={busy}
          groupBy={(option) => option.circleName}
          getOptionLabel={(option) => option.label}
          isOptionEqualToValue={(option, val) => option.person.id === val.person.id}
          renderOption={(props, option) => (
            <Box
              component="li"
              {...props}
              sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}
            >
              <PersonAvatar person={option.person} size={32} />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" noWrap>
                  {option.label}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {option.person.faceCount} photo
                  {option.person.faceCount === 1 ? '' : 's'}
                </Typography>
              </Box>
            </Box>
          )}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Find a person"
              placeholder="Search by name"
            />
          )}
        />
        <Box>
          <Button
            variant="contained"
            onClick={() => void handleLink()}
            disabled={busy || !selected}
          >
            {profile.linkedPerson ? 'Change linked person' : 'Link this person'}
          </Button>
        </Box>
      </Stack>
    );
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Linked person
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Link your account to the person MemoriaHub recognizes in your photos.
          You can then use their picture as your profile picture.
        </Typography>

        {profile.linkedPerson && linkedPersonRecord && (
          <>
            <Stack
              direction="row"
              spacing={2}
              sx={{ alignItems: 'center', mb: 2 }}
            >
              <PersonAvatar person={linkedPersonRecord} size={40} />
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography variant="subtitle2" noWrap>
                  {profile.linkedPerson.name ?? 'Unnamed person'}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  in {profile.linkedPerson.circleName}
                </Typography>
              </Box>
              <Button
                size="small"
                color="inherit"
                startIcon={<LinkOffIcon />}
                onClick={() => void handleUnlink()}
                disabled={busy}
              >
                Unlink
              </Button>
            </Stack>
            <Divider sx={{ mb: 2 }} />
          </>
        )}

        {renderBody()}
      </CardContent>
    </Card>
  );
}
