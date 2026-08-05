/**
 * Circle detail → Members and Invites — the DataTable declarations
 * (issue #260, epic #238).
 *
 * These two tables are the per-circle half of the identity-and-access group: a
 * circle member row is somebody's access to a family library, and an invite row
 * is access that has been offered but not yet taken up.
 *
 * ## Role is `primary`
 *
 * Per-circle role (`circle_admin` / `collaborator` / `viewer`) is the "what can
 * this person do" signal, so it leads the card beside the member's name — the
 * same treatment Status gets on the users, allowlist and PAT tables.
 *
 * ## The role editor lives in `render`, and it is gated by the CALLER
 *
 * `buildCircleMemberColumns` takes `canManage` and returns either an inline
 * `Select` (edit) or plain text (read). This is the single most important
 * property of this migration: the pre-#260 page hid the whole Actions
 * `<TableCell>` and swapped the `Select` for a `<Typography>` when the caller
 * lacked `circle_admin`, and a card renderer that rebuilt its own field list
 * would have quietly reintroduced an editable control for a viewer. A column's
 * `render` is used VERBATIM in every layout (docs/specs/datatable.md §3), so
 * gating it here gates it in the grid, in the tablet expander and on the card,
 * once.
 *
 * Row actions are gated the same way, by building the action ARRAY from
 * `canManage` in `CircleDetailPage.tsx` rather than by hiding a rendered
 * control.
 *
 * Neither endpoint (`GET /api/circles/:id/members`, `.../invites`) accepts
 * pagination, sort or filter params, so none of the three is declared — a
 * control the server cannot honour is the affordance the contract refuses (§4).
 */

import {
  Avatar,
  Box,
  Chip,
  FormControl,
  MenuItem,
  Select,
  Typography,
} from '@mui/material';
import type { DataTableColumn } from '../../components/datatable';
import type { CircleInvite, CircleMember, CircleRole } from '../../types/circles';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Persistence key for `user_settings.dataTables['circle-members']`. */
export const CIRCLE_MEMBERS_TABLE_ID = 'circle-members';
/** Persistence key for `user_settings.dataTables['circle-invites']`. */
export const CIRCLE_INVITES_TABLE_ID = 'circle-invites';

export const ROLE_LABELS: Record<CircleRole, string> = {
  circle_admin: 'Admin',
  collaborator: 'Collaborator',
  viewer: 'Viewer',
};

const ROLE_ORDER: CircleRole[] = ['circle_admin', 'collaborator', 'viewer'];

/** The member's own label — the card headline and every control's suffix. */
export function memberLabel(member: CircleMember): string {
  return member.user.displayName ?? member.user.email;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export interface CircleMemberColumnOptions {
  /** True only for a circle_admin (or a system admin) — see `canManage`. */
  canManage: boolean;
  onChangeRole: (userId: string, role: CircleRole) => void;
}

export function buildCircleMemberColumns({
  canManage,
  onChangeRole,
}: CircleMemberColumnOptions): DataTableColumn<CircleMember>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'member',
      label: 'Member',
      priority: 'primary',
      value: memberLabel,
      render: (member) => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Avatar
            src={member.user.profileImageUrl ?? undefined}
            sx={{ width: 32, height: 32, fontSize: 14, flexShrink: 0 }}
          >
            {(member.user.displayName ?? member.user.email).charAt(0).toUpperCase()}
          </Avatar>
          <Typography variant="body2" noWrap>
            {member.user.displayName ?? '—'}
          </Typography>
        </Box>
      ),
      minWidth: 200,
      flex: 1.2,
    },
    {
      id: 'role',
      label: 'Role',
      priority: 'primary',
      value: (member) => ROLE_LABELS[member.role],
      // Gated HERE, so the grid, the tablet expander and the card all get the
      // same control. A viewer never receives an editable Select.
      render: canManage
        ? (member) => (
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <Select
                value={member.role}
                inputProps={{ 'aria-label': `Role for ${memberLabel(member)}` }}
                onChange={(event) =>
                  onChangeRole(member.userId, event.target.value as CircleRole)
                }
              >
                {ROLE_ORDER.map((role) => (
                  <MenuItem key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )
        : (member) => <Typography variant="body2">{ROLE_LABELS[member.role]}</Typography>,
      minWidth: 170,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'email',
      label: 'Email',
      priority: 'secondary',
      value: (member) => member.user.email,
      minWidth: 220,
      flex: 1,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'createdAt',
      label: 'Member since',
      priority: 'detail',
      value: (member) => member.createdAt,
      render: (member) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatDate(member.createdAt)}
        </Typography>
      ),
      minWidth: 140,
    },
  ];
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/** A claimed invite is history; a pending one is live, unused access. */
export function isInviteClaimed(invite: CircleInvite): boolean {
  return Boolean(invite.claimedAt);
}

export function buildCircleInviteColumns(): DataTableColumn<CircleInvite>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'email',
      label: 'Email',
      priority: 'primary',
      value: (invite) => invite.email,
      minWidth: 220,
      flex: 1.2,
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      value: (invite) => (isInviteClaimed(invite) ? 'Claimed' : 'Pending'),
      render: (invite) => (
        <Chip
          label={isInviteClaimed(invite) ? 'Claimed' : 'Pending'}
          size="small"
          color={isInviteClaimed(invite) ? 'success' : 'default'}
          variant="outlined"
        />
      ),
      width: 130,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'role',
      label: 'Role',
      priority: 'secondary',
      value: (invite) => ROLE_LABELS[invite.role],
      minWidth: 140,
    },
    {
      id: 'addedAt',
      label: 'Invited',
      priority: 'secondary',
      value: (invite) => invite.addedAt,
      render: (invite) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatDate(invite.addedAt)}
        </Typography>
      ),
      minWidth: 140,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'notes',
      label: 'Notes',
      priority: 'detail',
      value: (invite) => invite.notes,
      truncate: true,
      minWidth: 200,
      flex: 2,
    },
  ];
}
