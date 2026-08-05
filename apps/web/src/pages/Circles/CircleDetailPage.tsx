/**
 * Circle detail — Members and Invites.
 *
 * Both tables were migrated onto the shared DataTable in issue #260
 * (epic #238). What that deleted: two hand-rolled `<Table>` blocks whose
 * "Actions" column vanished entirely for a caller without `circle_admin`, and
 * two bare `IconButton`s that removed a member / revoked an invite on a single
 * unconfirmed click.
 *
 * The permission model is UNCHANGED — `canManage` is still
 * `isAdmin || activeCircleRole === 'circle_admin'`, and it still decides
 * exactly the same three things (the role editor, the member/invite row
 * actions, and the "Invite by Email" button). What changed is WHERE it is
 * applied: the role editor is gated inside the column's `render`
 * (`circleMembersTable.tsx`) and the row actions by building the action array
 * from `canManage` here. Because a column's `render` and a table's
 * `rowActions` are used verbatim by every renderer, a viewer gets read-only
 * text and no destructive control on the grid, in the tablet row expander AND
 * on a phone card — one gate, three layouts, rather than a grid-only gate a
 * card renderer could quietly drop.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Container,
  Typography,
  Box,
  Tabs,
  Tab,
  Paper,
  Button,
  IconButton,
  Select,
  MenuItem,
  CircularProgress,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
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
import { DataTable, type DataTableRowAction } from '../../components/datatable';
import {
  CIRCLE_INVITES_TABLE_ID,
  CIRCLE_MEMBERS_TABLE_ID,
  buildCircleInviteColumns,
  buildCircleMemberColumns,
  isInviteClaimed,
} from './circleMembersTable';
import type { Circle, CircleInvite, CircleMember, CircleRole } from '../../types/circles';

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
  const [actionError, setActionError] = useState<string | null>(null);

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

  // --- Members table ---------------------------------------------------------

  const handleChangeRole = useCallback(
    (userId: string, role: CircleRole) => {
      void changeRole(userId, role).catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : 'Failed to change role');
      });
    },
    [changeRole],
  );

  const memberColumns = useMemo(
    () => buildCircleMemberColumns({ canManage, onChangeRole: handleChangeRole }),
    [canManage, handleChangeRole],
  );

  const handleRemoveMember = useCallback(
    async (member: CircleMember) => {
      setActionError(null);
      try {
        await removeMemberById(member.userId);
        setSuccessMsg(`${member.user.email} removed from this circle.`);
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : 'Failed to remove member');
      }
    },
    [removeMemberById],
  );

  // Built from `canManage`, so a viewer has no destructive control in ANY
  // renderer — not merely one that is off-screen on a narrow layout.
  const memberActions = useMemo<DataTableRowAction<CircleMember>[]>(() => {
    if (!canManage) return [];
    return [
      {
        id: 'remove-member',
        label: 'Remove from circle',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        confirm: {
          title: 'Remove member?',
          description: (member) =>
            `${member.user.email} will lose access to this circle and everything in it.`,
          confirmLabel: 'Remove',
        },
        onClick: (member) => void handleRemoveMember(member),
      },
    ];
  }, [canManage, handleRemoveMember]);

  // --- Invites table ---------------------------------------------------------

  const inviteColumns = useMemo(() => buildCircleInviteColumns(), []);

  const handleCancelInvite = useCallback(
    async (invite: CircleInvite) => {
      setActionError(null);
      try {
        await cancelInvite(invite.id);
        setSuccessMsg(`Invite for ${invite.email} revoked.`);
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : 'Failed to revoke invite');
      }
    },
    [cancelInvite],
  );

  const inviteActions = useMemo<DataTableRowAction<CircleInvite>[]>(() => {
    if (!canManage) return [];
    return [
      {
        id: 'revoke-invite',
        label: 'Revoke invite',
        icon: <DeleteIcon fontSize="small" />,
        destructive: true,
        // A claimed invite is history — revoking it would do nothing, so the
        // control is disabled rather than silently no-op.
        disabled: (invite) => isInviteClaimed(invite),
        confirm: {
          title: 'Revoke invite?',
          description: (invite) =>
            `The invitation for ${invite.email} will be cancelled. They will not be able to join with it.`,
          confirmLabel: 'Revoke',
        },
        onClick: (invite) => void handleCancelInvite(invite),
      },
    ];
  }, [canManage, handleCancelInvite]);

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
          <Box sx={{ px: 2, pb: 2, minWidth: 0 }}>
            {actionError && (
              <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>
                {actionError}
              </Alert>
            )}
            {/* Rendered unconditionally; `loading` is a prop, never a branch. */}
            <DataTable<CircleMember>
              columns={memberColumns}
              rows={members}
              rowId={(member) => member.id}
              tableId={CIRCLE_MEMBERS_TABLE_ID}
              ariaLabel="Circle members"
              loading={membersLoading}
              error={membersError}
              emptyState={
                <Typography variant="body2" color="text.secondary">
                  No members yet
                </Typography>
              }
              rowActions={memberActions}
              csvExport={{ filename: 'circle-members' }}
            />
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
            <DataTable<CircleInvite>
              columns={inviteColumns}
              rows={invites}
              rowId={(invite) => invite.id}
              tableId={CIRCLE_INVITES_TABLE_ID}
              ariaLabel="Circle invites"
              loading={invitesLoading}
              error={invitesError}
              emptyState={
                <Typography variant="body2" color="text.secondary">
                  No invites yet
                </Typography>
              }
              rowActions={inviteActions}
              csvExport={{ filename: 'circle-invites' }}
            />
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
