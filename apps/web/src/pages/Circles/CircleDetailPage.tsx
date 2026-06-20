import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Container,
  Typography,
  Box,
  Tabs,
  Tab,
  Paper,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Button,
  IconButton,
  Select,
  MenuItem,
  Chip,
  CircularProgress,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
  Avatar,
  Switch,
  FormControlLabel,
  Snackbar,
  Checkbox,
  Divider,
} from '@mui/material';
import {
  Delete as DeleteIcon,
  ArrowBack as BackIcon,
  PersonAdd as InviteIcon,
  Edit as EditIcon,
} from '@mui/icons-material';
import { useCircleMembers } from '../../hooks/useCircleMembers';
import { useCircleInvites } from '../../hooks/useCircleInvites';
import { useCircleContext } from '../../contexts/CircleContext';
import { usePermissions } from '../../hooks/usePermissions';
import { getCircle, updateCircle } from '../../services/circles';
import { getCircleFaceSettings, updateCircleFaceSettings } from '../../services/face';
import { getCircleTaggingSettings, updateCircleTaggingSettings } from '../../services/tagging';
import type { CircleTaggingSettings } from '../../services/tagging';
import { getCircleBurstSettings, updateCircleBurstSettings, runBurstBackfill } from '../../services/bursts';
import type { CircleBurstSettings } from '../../services/bursts';
import type { Circle, CircleRole } from '../../types/circles';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel({ children, value, index }: TabPanelProps) {
  return (
    <div role="tabpanel" hidden={value !== index}>
      {value === index && <Box sx={{ pt: 2 }}>{children}</Box>}
    </div>
  );
}

const ROLE_LABELS: Record<CircleRole, string> = {
  circle_admin: 'Admin',
  collaborator: 'Collaborator',
  viewer: 'Viewer',
};

export default function CircleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isAdmin } = usePermissions();
  const { activeCircleRole } = useCircleContext();

  const circleId = id ?? '';

  const [circle, setCircle] = useState<Circle | null>(null);
  const [circleLoading, setCircleLoading] = useState(true);
  const [circleError, setCircleError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);

  // Members
  const { members, loading: membersLoading, error: membersError, fetchMembers, changeRole, removeMemberById } =
    useCircleMembers(circleId);

  // Invites
  const { invites, loading: invitesLoading, error: invitesError, fetchInvites, sendInvite, cancelInvite } =
    useCircleInvites(circleId);

  // Face settings state
  const [faceSettings, setFaceSettings] = useState<{ faceRecognitionEnabled: boolean } | null>(null);
  const [faceSettingsLoading, setFaceSettingsLoading] = useState(false);
  const [faceSettingsError, setFaceSettingsError] = useState<string | null>(null);
  const [faceTogglingLoading, setFaceTogglingLoading] = useState(false);
  const [faceSuccessMsg, setFaceSuccessMsg] = useState<string | null>(null);

  // Tagging settings state
  const [taggingSettings, setTaggingSettings] = useState<CircleTaggingSettings | null>(null);
  const [taggingSettingsLoading, setTaggingSettingsLoading] = useState(false);
  const [taggingSettingsError, setTaggingSettingsError] = useState<string | null>(null);
  const [taggingTogglingLoading, setTaggingTogglingLoading] = useState(false);

  // Burst settings state
  const [burstSettings, setBurstSettings] = useState<CircleBurstSettings | null>(null);
  const [burstSettingsLoading, setBurstSettingsLoading] = useState(false);
  const [burstSettingsError, setBurstSettingsError] = useState<string | null>(null);
  const [burstTogglingLoading, setBurstTogglingLoading] = useState(false);

  // Burst scan state
  const [burstScanFrom, setBurstScanFrom] = useState('');
  const [burstScanTo, setBurstScanTo] = useState('');
  const [burstScanForce, setBurstScanForce] = useState(false);
  const [burstScanning, setBurstScanning] = useState(false);
  const [burstScanError, setBurstScanError] = useState<string | null>(null);

  // Invite dialog
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<CircleRole>('viewer');
  const [inviteNotes, setInviteNotes] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Edit circle dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const canManage = isAdmin || activeCircleRole === 'circle_admin';
  const canBackfill = isAdmin || activeCircleRole === 'collaborator' || activeCircleRole === 'circle_admin';

  useEffect(() => {
    if (!circleId) return;
    setCircleLoading(true);
    getCircle(circleId)
      .then((c) => {
        setCircle(c);
        setCircleError(null);
      })
      .catch((err: unknown) => {
        setCircleError(err instanceof Error ? err.message : 'Failed to load circle');
      })
      .finally(() => setCircleLoading(false));
  }, [circleId]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers]);

  useEffect(() => {
    void fetchInvites();
  }, [fetchInvites]);

  useEffect(() => {
    if (!circleId) return;
    setFaceSettingsLoading(true);
    setFaceSettingsError(null);
    getCircleFaceSettings(circleId)
      .then(setFaceSettings)
      .catch((err: unknown) => {
        setFaceSettingsError(err instanceof Error ? err.message : 'Failed to load face settings');
      })
      .finally(() => setFaceSettingsLoading(false));
  }, [circleId]);

  useEffect(() => {
    if (!circleId) return;
    setTaggingSettingsLoading(true);
    setTaggingSettingsError(null);
    getCircleTaggingSettings(circleId)
      .then(setTaggingSettings)
      .catch((err: unknown) => {
        setTaggingSettingsError(err instanceof Error ? err.message : 'Failed to load tagging settings');
      })
      .finally(() => setTaggingSettingsLoading(false));
  }, [circleId]);

  useEffect(() => {
    if (!circleId) return;
    setBurstSettingsLoading(true);
    setBurstSettingsError(null);
    getCircleBurstSettings(circleId)
      .then(setBurstSettings)
      .catch((err: unknown) => {
        setBurstSettingsError(err instanceof Error ? err.message : 'Failed to load burst settings');
      })
      .finally(() => setBurstSettingsLoading(false));
  }, [circleId]);

  const handleFaceToggle = async (enabled: boolean) => {
    setFaceTogglingLoading(true);
    setFaceSettingsError(null);
    try {
      const updated = await updateCircleFaceSettings(circleId, enabled);
      setFaceSettings(updated);
      setFaceSuccessMsg(enabled ? 'Face recognition enabled.' : 'Face recognition disabled.');
    } catch (err: unknown) {
      setFaceSettingsError(err instanceof Error ? err.message : 'Failed to update face recognition setting');
    } finally {
      setFaceTogglingLoading(false);
    }
  };

  const handleTaggingToggle = async (enabled: boolean) => {
    setTaggingTogglingLoading(true);
    setTaggingSettingsError(null);
    try {
      const updated = await updateCircleTaggingSettings(circleId, enabled);
      setTaggingSettings(updated);
      setFaceSuccessMsg(enabled ? 'Auto-tagging enabled.' : 'Auto-tagging disabled.');
    } catch (err: unknown) {
      setTaggingSettingsError(err instanceof Error ? err.message : 'Failed to update auto-tagging setting');
    } finally {
      setTaggingTogglingLoading(false);
    }
  };

  const handleBurstToggle = async (enabled: boolean) => {
    setBurstTogglingLoading(true);
    setBurstSettingsError(null);
    try {
      const updated = await updateCircleBurstSettings(circleId, enabled);
      setBurstSettings(updated);
      setFaceSuccessMsg(enabled ? 'Burst detection enabled.' : 'Burst detection disabled.');
    } catch (err: unknown) {
      setBurstSettingsError(err instanceof Error ? err.message : 'Failed to update burst detection setting');
    } finally {
      setBurstTogglingLoading(false);
    }
  };

  const handleBurstScan = async () => {
    if (!circleId) return;
    setBurstScanError(null);
    setBurstScanning(true);
    try {
      const opts: { from?: string; to?: string; force?: boolean } = {};
      if (burstScanFrom) opts.from = burstScanFrom;
      if (burstScanTo) opts.to = burstScanTo;
      if (burstScanForce) opts.force = true;
      const result = await runBurstBackfill(circleId, opts);
      setFaceSuccessMsg(`Queued ${result.enqueued} photo${result.enqueued !== 1 ? 's' : ''} for burst scanning`);
    } catch (err: unknown) {
      setBurstScanError(err instanceof Error ? err.message : 'Failed to start burst scan');
    } finally {
      setBurstScanning(false);
    }
  };

  const handleEditOpen = () => {
    setEditName(circle?.name ?? '');
    setEditDescription(circle?.description ?? '');
    setEditError(null);
    setEditOpen(true);
  };

  const handleEditSave = async () => {
    if (!circle || !editName.trim()) return;
    setSaving(true);
    setEditError(null);
    try {
      const updated = await updateCircle(circle.id, {
        name: editName.trim(),
        description: editDescription.trim() || undefined,
      });
      setCircle(updated);
      setEditOpen(false);
      setFaceSuccessMsg('Circle updated.');
    } catch (err: unknown) {
      setEditError(err instanceof Error ? err.message : 'Failed to update circle');
    } finally {
      setSaving(false);
    }
  };

  const handleSendInvite = useCallback(async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteError(null);
    try {
      await sendInvite(inviteEmail.trim(), inviteRole, inviteNotes.trim() || undefined);
      setInviteOpen(false);
      setInviteEmail('');
      setInviteRole('viewer');
      setInviteNotes('');
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Failed to send invite');
    } finally {
      setInviting(false);
    }
  }, [inviteEmail, inviteRole, inviteNotes, sendInvite]);

  if (circleLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (circleError) {
    return (
      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Alert severity="error">{circleError}</Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
        <IconButton onClick={() => navigate('/circles')} aria-label="Back to circles">
          <BackIcon />
        </IconButton>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" component="h1">
            {circle?.name}
          </Typography>
          {circle?.description && (
            <Typography variant="body2" color="text.secondary">
              {circle.description}
            </Typography>
          )}
        </Box>
        {canManage && (
          <IconButton onClick={handleEditOpen} aria-label="Edit circle">
            <EditIcon />
          </IconButton>
        )}
      </Box>

      <Paper variant="outlined">
        <Tabs value={tab} onChange={(_, v: number) => setTab(v)} sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab label="Members" />
          <Tab label="Invites" />
          <Tab label="Settings" />
        </Tabs>

        {/* Members tab */}
        <TabPanel value={tab} index={0}>
          <Box sx={{ px: 2, pb: 2 }}>
            {membersError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {membersError}
              </Alert>
            )}
            {membersLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress />
              </Box>
            ) : (
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Member</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell>Role</TableCell>
                    {canManage && <TableCell align="right">Actions</TableCell>}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {members.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={canManage ? 4 : 3} align="center">
                        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                          No members yet
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                  {members.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Avatar
                            src={member.user.profileImageUrl ?? undefined}
                            sx={{ width: 32, height: 32, fontSize: 14 }}
                          >
                            {(member.user.displayName ?? member.user.email).charAt(0).toUpperCase()}
                          </Avatar>
                          <Typography variant="body2">
                            {member.user.displayName ?? '—'}
                          </Typography>
                        </Box>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">{member.user.email}</Typography>
                      </TableCell>
                      <TableCell>
                        {canManage ? (
                          <FormControl size="small" sx={{ minWidth: 130 }}>
                            <Select
                              value={member.role}
                              onChange={(e) =>
                                void changeRole(member.userId, e.target.value as CircleRole)
                              }
                            >
                              <MenuItem value="circle_admin">Admin</MenuItem>
                              <MenuItem value="collaborator">Collaborator</MenuItem>
                              <MenuItem value="viewer">Viewer</MenuItem>
                            </Select>
                          </FormControl>
                        ) : (
                          <Typography variant="body2">{ROLE_LABELS[member.role]}</Typography>
                        )}
                      </TableCell>
                      {canManage && (
                        <TableCell align="right">
                          <IconButton
                            size="small"
                            onClick={() => void removeMemberById(member.userId)}
                            aria-label={`Remove ${member.user.email}`}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Box>
        </TabPanel>

        {/* Invites tab */}
        <TabPanel value={tab} index={1}>
          <Box sx={{ px: 2, pb: 2 }}>
            {canManage && (
              <Box sx={{ mb: 2 }}>
                <Button
                  variant="outlined"
                  startIcon={<InviteIcon />}
                  onClick={() => setInviteOpen(true)}
                >
                  Invite by Email
                </Button>
              </Box>
            )}
            {invitesError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {invitesError}
              </Alert>
            )}
            {invitesLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress />
              </Box>
            ) : (
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>Email</TableCell>
                    <TableCell>Role</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Date</TableCell>
                    {canManage && <TableCell align="right">Actions</TableCell>}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {invites.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={canManage ? 5 : 4} align="center">
                        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                          No invites yet
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                  {invites.map((invite) => (
                    <TableRow key={invite.id}>
                      <TableCell>
                        <Typography variant="body2">{invite.email}</Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">{ROLE_LABELS[invite.role]}</Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={invite.claimedAt ? 'Claimed' : 'Pending'}
                          size="small"
                          color={invite.claimedAt ? 'success' : 'default'}
                          variant="outlined"
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">
                          {new Date(invite.addedAt).toLocaleDateString()}
                        </Typography>
                      </TableCell>
                      {canManage && (
                        <TableCell align="right">
                          {!invite.claimedAt && (
                            <IconButton
                              size="small"
                              onClick={() => void cancelInvite(invite.id)}
                              aria-label={`Revoke invite for ${invite.email}`}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Box>
        </TabPanel>

        {/* Settings tab */}
        <TabPanel value={tab} index={2}>
          <Box sx={{ px: 2, pb: 2 }}>
            <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 'medium' }}>
              Face Recognition
            </Typography>
            {faceSettingsLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress />
              </Box>
            ) : (
              <>
                {faceSettingsError && (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    {faceSettingsError}
                  </Alert>
                )}
                <Paper variant="outlined" sx={{ p: 2 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Face recognition uses biometric data (face embeddings) to identify people across
                    photos. It is opt-in per circle. Disabling stops new processing; existing face data
                    remains unless you delete biometrics on the People page.
                  </Typography>
                  {canManage ? (
                    <FormControlLabel
                      control={
                        <Switch
                          checked={faceSettings?.faceRecognitionEnabled ?? false}
                          onChange={(e) => void handleFaceToggle(e.target.checked)}
                          disabled={faceTogglingLoading || !faceSettings}
                          color="primary"
                        />
                      }
                      label={faceTogglingLoading ? 'Updating…' : 'Enable face recognition'}
                    />
                  ) : (
                    <Typography variant="body2">
                      Face recognition is currently{' '}
                      <strong>
                        {faceSettings?.faceRecognitionEnabled ? 'Enabled' : 'Disabled'}
                      </strong>
                    </Typography>
                  )}
                </Paper>

                <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Auto-tagging uses AI to automatically add tags to photos in this circle. It is opt-in per circle.
                  </Typography>
                  {taggingSettingsError && (
                    <Alert severity="error" sx={{ mb: 1 }}>
                      {taggingSettingsError}
                    </Alert>
                  )}
                  {taggingSettingsLoading ? (
                    <CircularProgress size={20} />
                  ) : canManage ? (
                    <FormControlLabel
                      control={
                        <Switch
                          checked={taggingSettings?.autoTaggingEnabled ?? false}
                          onChange={(e) => void handleTaggingToggle(e.target.checked)}
                          disabled={taggingTogglingLoading || !taggingSettings}
                          color="primary"
                        />
                      }
                      label={taggingTogglingLoading ? 'Updating…' : 'Enable auto-tagging'}
                    />
                  ) : (
                    <Typography variant="body2">
                      Auto-tagging is currently{' '}
                      <strong>
                        {taggingSettings?.autoTaggingEnabled ? 'Enabled' : 'Disabled'}
                      </strong>
                    </Typography>
                  )}
                </Paper>

                <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Burst detection automatically groups similar photos taken in quick succession, so
                    you can review and keep only the best shot. It is opt-in per circle.
                  </Typography>
                  {burstSettingsError && (
                    <Alert severity="error" sx={{ mb: 1 }}>
                      {burstSettingsError}
                    </Alert>
                  )}
                  {burstSettingsLoading ? (
                    <CircularProgress size={20} />
                  ) : canManage ? (
                    <FormControlLabel
                      control={
                        <Switch
                          checked={burstSettings?.burstDetectionEnabled ?? false}
                          onChange={(e) => void handleBurstToggle(e.target.checked)}
                          disabled={burstTogglingLoading || !burstSettings}
                          color="primary"
                        />
                      }
                      label={burstTogglingLoading ? 'Updating…' : 'Enable burst detection'}
                    />
                  ) : (
                    <Typography variant="body2">
                      Burst detection is currently{' '}
                      <strong>
                        {burstSettings?.burstDetectionEnabled ? 'Enabled' : 'Disabled'}
                      </strong>
                    </Typography>
                  )}

                  {burstSettings?.burstDetectionEnabled && canBackfill && (
                    <>
                      <Divider sx={{ my: 2 }} />
                      <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 'medium' }}>
                        Scan for bursts
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                        Run a retroactive scan to compute perceptual hashes for older photos and group
                        bursts in the background. Results appear in Review Bursts once processing
                        completes. Leave date fields empty to scan the entire circle.
                      </Typography>
                      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 2, mb: 2 }}>
                        <TextField
                          label="From (capture date)"
                          type="date"
                          value={burstScanFrom}
                          onChange={(e) => setBurstScanFrom(e.target.value)}
                          slotProps={{ inputLabel: { shrink: true } }}
                          size="small"
                          sx={{ flex: 1 }}
                          disabled={burstScanning}
                        />
                        <TextField
                          label="To (capture date)"
                          type="date"
                          value={burstScanTo}
                          onChange={(e) => setBurstScanTo(e.target.value)}
                          slotProps={{ inputLabel: { shrink: true } }}
                          size="small"
                          sx={{ flex: 1 }}
                          disabled={burstScanning}
                        />
                      </Box>
                      <FormControlLabel
                        control={
                          <Checkbox
                            checked={burstScanForce}
                            onChange={(e) => setBurstScanForce(e.target.checked)}
                            disabled={burstScanning}
                            size="small"
                          />
                        }
                        label={
                          <Typography variant="body2">
                            Re-scan all (force) — reprocess photos that were already scanned
                          </Typography>
                        }
                        sx={{ mb: 2 }}
                      />
                      {burstScanError && (
                        <Alert severity="error" sx={{ mb: 2 }}>
                          {burstScanError}
                        </Alert>
                      )}
                      {burstScanFrom && burstScanTo && burstScanFrom > burstScanTo && (
                        <Alert severity="warning" sx={{ mb: 2 }}>
                          "From" date must be on or before "To" date.
                        </Alert>
                      )}
                      <Button
                        variant="outlined"
                        size="small"
                        onClick={() => void handleBurstScan()}
                        disabled={
                          burstScanning ||
                          Boolean(burstScanFrom && burstScanTo && burstScanFrom > burstScanTo)
                        }
                        startIcon={burstScanning ? <CircularProgress size={14} /> : undefined}
                      >
                        {burstScanning ? 'Scanning…' : 'Scan for bursts'}
                      </Button>
                    </>
                  )}
                </Paper>
              </>
            )}
          </Box>
        </TabPanel>
      </Paper>

      <Snackbar
        open={Boolean(faceSuccessMsg)}
        autoHideDuration={3000}
        onClose={() => setFaceSuccessMsg(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setFaceSuccessMsg(null)} severity="success" sx={{ width: '100%' }}>
          {faceSuccessMsg}
        </Alert>
      </Snackbar>

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onClose={() => !inviting && setInviteOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Invite to Circle</DialogTitle>
        <DialogContent>
          {inviteError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {inviteError}
            </Alert>
          )}
          <TextField
            autoFocus
            label="Email address"
            type="email"
            fullWidth
            required
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            sx={{ mt: 1, mb: 2 }}
          />
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>Role</InputLabel>
            <Select
              label="Role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as CircleRole)}
            >
              <MenuItem value="circle_admin">Admin</MenuItem>
              <MenuItem value="collaborator">Collaborator</MenuItem>
              <MenuItem value="viewer">Viewer</MenuItem>
            </Select>
          </FormControl>
          <TextField
            label="Notes (optional)"
            fullWidth
            multiline
            rows={2}
            value={inviteNotes}
            onChange={(e) => setInviteNotes(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInviteOpen(false)} disabled={inviting}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSendInvite()}
            disabled={inviting || !inviteEmail.trim()}
            startIcon={inviting ? <CircularProgress size={16} /> : undefined}
          >
            {inviting ? 'Sending...' : 'Send Invite'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit circle dialog */}
      <Dialog open={editOpen} onClose={() => !saving && setEditOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit circle</DialogTitle>
        <DialogContent>
          {editError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {editError}
            </Alert>
          )}
          <TextField
            autoFocus
            label="Name"
            fullWidth
            required
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            sx={{ mt: 1, mb: 2 }}
          />
          <TextField
            label="Description"
            fullWidth
            multiline
            rows={3}
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleEditSave()}
            disabled={
              saving ||
              !editName.trim() ||
              (editName.trim() === (circle?.name ?? '') &&
                editDescription.trim() === (circle?.description ?? ''))
            }
            startIcon={saving ? <CircularProgress size={16} /> : undefined}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
