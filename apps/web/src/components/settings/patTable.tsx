/**
 * User Settings → Personal Access Tokens — the DataTable declaration
 * (issue #260, epic #238).
 *
 * ## The security invariant this module encodes
 *
 * A PAT's raw value is shown ONCE, at creation, and never again — the API
 * stores only a hash. The table has never had the raw token and still does not;
 * what it has is `tokenPrefix`, the first few characters kept for
 * identification.
 *
 * That column is declared **`exportable: false`** anyway. CSV export writes a
 * column's `value` scalar for every row on the page (docs/specs/datatable.md
 * §16.4), and a downloaded file outlives the session that produced it: it lands
 * in a Downloads folder, gets mailed around, and ends up in a support ticket.
 * Token material — even a prefix that narrows a brute-force search — has no
 * business in one. `exportable: false` is the declarative way to say so, and it
 * is the rule every future table carrying secret material inherits (share
 * tokens, node credentials, API keys).
 *
 * ## Status is `primary`
 *
 * Active / Expired / Revoked is the whole point of the row: an operator scans
 * this list to find the credential that is still live. It leads the card beside
 * the token's name.
 *
 * ## No filtering, no sorting, no pagination
 *
 * `GET /api/pat` returns the caller's own tokens as a plain array — no
 * `page`/`sortBy`/`status` params exist — so none of the three is declared.
 * Sorting or filtering the table would only ever sort or filter one already
 * complete page, which is the "looks live, does nothing" affordance the
 * contract refuses (§4, §10.1).
 */

import { Chip, Typography } from '@mui/material';
import type { DataTableColumn } from '../datatable';
import type { PersonalAccessToken } from '../../types';

/** Persistence key for `user_settings.dataTables['settings-pats']`. */
export const PAT_TABLE_ID = 'settings-pats';

export type PatStatus = 'active' | 'expired' | 'revoked';

/** Derived, never stored: revoked wins over expired, both over active. */
export function getTokenStatus(token: {
  expiresAt: string;
  revokedAt: string | null;
}): PatStatus {
  if (token.revokedAt) return 'revoked';
  if (new Date(token.expiresAt) < new Date()) return 'expired';
  return 'active';
}

const STATUS_LABEL: Record<PatStatus, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString();
}

export function buildPatColumns(): DataTableColumn<PersonalAccessToken>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'name',
      label: 'Name',
      priority: 'primary',
      // The card headline and every per-row control's accessible name
      // ("Revoke CI Pipeline") come from this scalar.
      value: (token) => token.name,
      minWidth: 180,
      flex: 1.2,
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      value: (token) => STATUS_LABEL[getTokenStatus(token)],
      render: (token) => {
        const status = getTokenStatus(token);
        if (status === 'active') return <Chip label="Active" color="success" size="small" />;
        if (status === 'expired') return <Chip label="Expired" size="small" />;
        return <Chip label="Revoked" color="error" size="small" />;
      },
      width: 130,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'tokenPrefix',
      label: 'Token prefix',
      priority: 'secondary',
      value: (token) => token.tokenPrefix,
      render: (token) => (
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {token.tokenPrefix}...
        </Typography>
      ),
      // SECURITY: token material never leaves the app in a file. See the module
      // docblock — this is the invariant, not a convenience.
      exportable: false,
      minWidth: 150,
    },
    {
      id: 'expiresAt',
      label: 'Expires',
      priority: 'secondary',
      value: (token) => token.expiresAt,
      render: (token) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatDate(token.expiresAt)}
        </Typography>
      ),
      minWidth: 130,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'createdAt',
      label: 'Created',
      priority: 'detail',
      value: (token) => token.createdAt,
      render: (token) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatDate(token.createdAt)}
        </Typography>
      ),
      minWidth: 130,
    },
    {
      id: 'lastUsedAt',
      label: 'Last used',
      priority: 'detail',
      value: (token) => token.lastUsedAt,
      render: (token) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {token.lastUsedAt ? formatDate(token.lastUsedAt) : 'Never'}
        </Typography>
      ),
      minWidth: 130,
    },
  ];
}
