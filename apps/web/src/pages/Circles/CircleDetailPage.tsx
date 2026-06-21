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
  Snackbar,
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

  const [successMsg, setSuccessMsg] = useState<string | null>(null);

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
      setSuccessMsg('Circle updated.');
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

      </Paper>

      <Snackbar
        open={Boolean(successMsg)}
        autoHideDuration={3000}
        onClose={() => setSuccessMsg(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSuccessMsg(null)} severity="success" sx={{ width: '100%' }}>
          {successMsg}
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
