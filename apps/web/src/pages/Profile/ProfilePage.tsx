import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Container,
  Grid,
  Snackbar,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  Face as FaceIcon,
  Google as GoogleIcon,
  RestartAlt as ResetIcon,
} from '@mui/icons-material';
import { useAuth } from '../../contexts/AuthContext';
import { useAuthedImage } from '../../hooks/useAuthedImage';
import { AvatarCropDialog } from '../../components/user/AvatarCropDialog';
import { LinkedPersonCard } from '../../components/user/LinkedPersonCard';
import { UserProfileCard } from '../../components/user/UserProfileCard';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import {
  applyLinkedPersonAvatar,
  deleteMyAvatar,
  getMyProfile,
  updateMyProfile,
  uploadMyAvatar,
} from '../../services/userProfile';
import type { AvatarSource, UserProfile } from '../../services/userProfile';

/** Mirrors the API's accepted avatar mime types. */
const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
].join(',');

/** Initials fallback, matching the derivation used by UserMenu / UserProfileCard. */
function initialsFor(displayName: string | null, email: string): string {
  return (
    displayName
      ?.split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || email[0]?.toUpperCase() || '?'
  );
}

/**
 * `/profile` — profile picture and display-name management (issue #354).
 *
 * Owns everything the `/settings` Profile card used to half-own: the display
 * name, and an explicit three-way avatar SOURCE (provider picture / uploaded
 * image / linked person's picture) that replaces the old, mutually-ignorant
 * `useProviderImage` + `customImageUrl` pair in `user_settings.profile`.
 *
 * Every mutation returns the whole refreshed profile, so local state is
 * replaced from the server rather than patched optimistically — and each one is
 * followed by `refreshUser()` so the top-bar avatar updates in the same tick.
 */
export default function ProfilePage() {
  const { refreshUser } = useAuth();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Upload flow: picked file → object URL → crop dialog → blob → POST.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);

  const { src: avatarSrc } = useAuthedImage(profile?.avatarUrl);

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------
  useEffect(() => {
    let active = true;
    getMyProfile()
      .then((data) => {
        if (!active) return;
        setProfile(data);
        setDisplayName(data.displayName ?? '');
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load profile');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Single owner of the crop object URL's lifetime: this cleanup fires both
  // when `cropSrc` is replaced and on unmount, so no handler has to revoke.
  useEffect(() => {
    if (!cropSrc) return;
    return () => URL.revokeObjectURL(cropSrc);
  }, [cropSrc]);

  /**
   * Apply a profile-returning mutation: replace local state, then refresh the
   * auth user so the top-bar avatar and name follow immediately.
   */
  const applyMutation = useCallback(
    async (run: () => Promise<UserProfile>, message: string) => {
      setActionError(null);
      const next = await run();
      setProfile(next);
      setDisplayName(next.displayName ?? '');
      // A stale top bar is cosmetic — never fail the mutation over it.
      await refreshUser().catch(() => undefined);
      setSuccessMessage(message);
      return next;
    },
    [refreshUser],
  );

  const runAvatarAction = useCallback(
    async (run: () => Promise<UserProfile>, message: string) => {
      setAvatarBusy(true);
      try {
        await applyMutation(run, message);
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : 'Failed to update profile picture',
        );
      } finally {
        setAvatarBusy(false);
      }
    },
    [applyMutation],
  );

  // -------------------------------------------------------------------------
  // Display name
  // -------------------------------------------------------------------------
  const handleSaveName = async () => {
    setSavingName(true);
    try {
      const trimmed = displayName.trim();
      // Empty clears the override rather than storing "" — the server then
      // falls back to the provider's name.
      await applyMutation(
        () => updateMyProfile({ displayName: trimmed === '' ? null : trimmed }),
        'Display name updated',
      );
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to update display name',
      );
    } finally {
      setSavingName(false);
    }
  };

  // -------------------------------------------------------------------------
  // Avatar source
  // -------------------------------------------------------------------------
  const handlePickFile = () => {
    setActionError(null);
    fileInputRef.current?.click();
  };

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset immediately so re-picking the same file fires `change` again.
    event.target.value = '';
    if (!file) return;
    setCropSrc(URL.createObjectURL(file));
  };

  const handleCropConfirm = async (blob: Blob) => {
    // Deliberately not caught here: the dialog owns the busy/error state for
    // this step, and closing on failure would discard the user's crop.
    await applyMutation(() => uploadMyAvatar(blob), 'Profile picture updated');
    setCropSrc(null);
  };

  const handleCropCancel = () => setCropSrc(null);

  const handleResetToProvider = () =>
    runAvatarAction(deleteMyAvatar, 'Reset to your Google picture');

  const handleUsePersonPicture = () =>
    runAvatarAction(applyLinkedPersonAvatar, "Using your linked person's picture");

  const handleSourceChange = (
    _event: React.MouseEvent<HTMLElement>,
    next: AvatarSource | null,
  ) => {
    // ToggleButtonGroup emits null when the active button is re-clicked; treat
    // that as "no change" rather than clearing the source.
    if (!next || !profile) return;
    if (next === 'oauth') void handleResetToProvider();
    else if (next === 'upload') handlePickFile();
    else void handleUsePersonPicture();
  };

  const handleLinkChange = async (personId: string | null) => {
    try {
      await applyMutation(
        () => updateMyProfile({ linkedPersonId: personId }),
        personId ? 'Person linked' : 'Person unlinked',
      );
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to update linked person',
      );
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (isLoading) return <LoadingSpinner />;

  if (!profile) {
    return (
      <Container maxWidth="md">
        <Box sx={{ py: 4 }}>
          <Typography variant="h4" component="h1" gutterBottom>
            Profile
          </Typography>
          <Alert severity="error">{loadError ?? 'Failed to load profile'}</Alert>
        </Box>
      </Container>
    );
  }

  const hasProviderImage = profile.providerProfileImageUrl !== null;
  const hasLinkedPerson = profile.linkedPerson !== null;
  const nameChanged = displayName.trim() !== (profile.displayName ?? '');

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Profile
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Manage how you appear across MemoriaHub
        </Typography>

        {actionError && (
          <Alert severity="error" sx={{ mb: 3 }} onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}

        <Grid container spacing={3}>
          {/* Account summary */}
          <Grid size={{ xs: 12, md: 5 }}>
            <UserProfileCard />
          </Grid>

          <Grid size={{ xs: 12, md: 7 }}>
            <Stack spacing={3}>
              {/* Profile picture */}
              <Card>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Profile picture
                  </Typography>

                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={3}
                    sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, mb: 3 }}
                  >
                    <Box sx={{ position: 'relative' }}>
                      <Avatar
                        src={avatarSrc ?? undefined}
                        alt={profile.displayName || profile.email}
                        sx={{
                          width: 120,
                          height: 120,
                          fontSize: '2.5rem',
                          bgcolor: 'primary.main',
                        }}
                      >
                        {initialsFor(profile.displayName, profile.email)}
                      </Avatar>
                      {avatarBusy && (
                        <CircularProgress
                          size={132}
                          thickness={1.5}
                          sx={{ position: 'absolute', top: -6, left: -6 }}
                        />
                      )}
                    </Box>

                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                        Choose where your picture comes from.
                      </Typography>

                      <ToggleButtonGroup
                        exclusive
                        value={profile.avatarSource}
                        onChange={handleSourceChange}
                        size="small"
                        aria-label="Profile picture source"
                        sx={{ flexWrap: 'wrap' }}
                      >
                        <ToggleButton
                          value="oauth"
                          disabled={avatarBusy || !hasProviderImage}
                        >
                          <GoogleIcon fontSize="small" sx={{ mr: 1 }} />
                          Google picture
                        </ToggleButton>
                        <ToggleButton value="upload" disabled={avatarBusy}>
                          <UploadIcon fontSize="small" sx={{ mr: 1 }} />
                          Upload an image
                        </ToggleButton>
                        <ToggleButton
                          value="person"
                          disabled={avatarBusy || !hasLinkedPerson}
                        >
                          <FaceIcon fontSize="small" sx={{ mr: 1 }} />
                          My linked person
                        </ToggleButton>
                      </ToggleButtonGroup>
                    </Box>
                  </Stack>

                  <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                    {/*
                      Tooltips need an enabled wrapper to receive pointer
                      events, hence the `span` around each disable-able button.
                    */}
                    <Tooltip
                      title={
                        hasProviderImage
                          ? ''
                          : 'Your Google account did not provide a profile picture.'
                      }
                    >
                      <span>
                        <Button
                          variant="outlined"
                          startIcon={<ResetIcon />}
                          onClick={() => void handleResetToProvider()}
                          disabled={avatarBusy || !hasProviderImage}
                        >
                          Reset to Google picture
                        </Button>
                      </span>
                    </Tooltip>

                    <Button
                      variant="outlined"
                      startIcon={<UploadIcon />}
                      onClick={handlePickFile}
                      disabled={avatarBusy}
                    >
                      Upload an image
                    </Button>

                    <Tooltip
                      title={
                        hasLinkedPerson
                          ? ''
                          : 'Link a person below to use their picture.'
                      }
                    >
                      <span>
                        <Button
                          variant="outlined"
                          startIcon={<FaceIcon />}
                          onClick={() => void handleUsePersonPicture()}
                          disabled={avatarBusy || !hasLinkedPerson}
                        >
                          Use my linked person's picture
                        </Button>
                      </span>
                    </Tooltip>
                  </Stack>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPTED_IMAGE_TYPES}
                    onChange={handleFileSelected}
                    style={{ display: 'none' }}
                    data-testid="avatar-file-input"
                  />
                </CardContent>
              </Card>

              {/* Your details */}
              <Card>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Your details
                  </Typography>

                  <Stack spacing={3} sx={{ mt: 2 }}>
                    <TextField
                      label="Display Name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder={profile.email.split('@')[0]}
                      helperText="Leave empty to use your Google name"
                      disabled={savingName}
                      fullWidth
                    />

                    <TextField
                      label="Email"
                      value={profile.email}
                      disabled
                      fullWidth
                      helperText="Email cannot be changed"
                    />

                    <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Button
                        variant="contained"
                        onClick={() => void handleSaveName()}
                        disabled={savingName || !nameChanged}
                      >
                        {savingName ? 'Saving…' : 'Save changes'}
                      </Button>
                    </Box>
                  </Stack>
                </CardContent>
              </Card>

              {/* Linked person */}
              <LinkedPersonCard
                profile={profile}
                onLinkChange={handleLinkChange}
                disabled={avatarBusy}
              />
            </Stack>
          </Grid>
        </Grid>

        <AvatarCropDialog
          open={cropSrc !== null}
          imageSrc={cropSrc}
          onCancel={handleCropCancel}
          onConfirm={handleCropConfirm}
        />

        <Snackbar
          open={!!successMessage}
          autoHideDuration={3000}
          onClose={() => setSuccessMessage(null)}
          message={successMessage}
        />
      </Box>
    </Container>
  );
}
