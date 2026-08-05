/**
 * Worker Nodes — the two DataTable declarations for `/admin/settings/nodes`
 * (issue #259).
 *
 * The page hosts two unrelated row types and therefore two independent tables,
 * each with its own `tableId` so a user's column/density choice on one does not
 * leak into the other:
 *
 *   - {@link buildWorkerNodeColumns} — the fleet (`admin-nodes`)
 *   - {@link buildNodeCredentialColumns} — the durable `nod_` credentials
 *     (`admin-node-credentials`)
 *
 * ## Status is `primary` on both
 *
 * Issue #259's decision: on a phone the card headline must answer "is this node
 * up?" / "is this token still valid?" before anything else. So `status` (nodes)
 * and the derived credential state both lead their card, beside the name.
 *
 * ## Nothing is `sortable` or `filterable`
 *
 * `GET /admin/nodes` and `GET /admin/nodes/credentials` return the whole list
 * with no query params at all — no page, no sort, no filter. Declaring any of
 * those would paint a control the server cannot honour (§4).
 */

import { Box, Chip, Tooltip, Typography } from '@mui/material';
import {
  CheckCircle as HealthyIcon,
  Warning as StaleIcon,
  Cancel as OfflineIcon,
} from '@mui/icons-material';
import type { DataTableColumn } from '../../components/datatable';
import type {
  AdminNodeCredentialDto,
  NodeHealth,
  NodeStatus,
  WorkerNodeDto,
} from '../../services/workers';
import { relativeTime } from '../../utils/formatBytes';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const WORKER_NODES_TABLE_ID = 'admin-nodes';
export const NODE_CREDENTIALS_TABLE_ID = 'admin-node-credentials';

// ---------------------------------------------------------------------------
// Node cell helpers
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<NodeStatus, 'default' | 'success' | 'warning' | 'error'> = {
  online: 'success',
  draining: 'warning',
  offline: 'default',
  disabled: 'error',
};

function StatusChip({ status }: { status: NodeStatus }) {
  return (
    <Chip label={status} color={STATUS_COLORS[status] ?? 'default'} size="small" variant="outlined" />
  );
}

const HEALTH_META: Record<
  NodeHealth,
  { color: 'success' | 'warning' | 'error'; label: string; Icon: typeof HealthyIcon }
> = {
  healthy: { color: 'success', label: 'Healthy', Icon: HealthyIcon },
  stale: { color: 'warning', label: 'Stale', Icon: StaleIcon },
  offline: { color: 'error', label: 'Offline', Icon: OfflineIcon },
};

/** Heartbeat-freshness pill driven by the server-derived `health` field. */
function HeartbeatPill({ node }: { node: WorkerNodeDto }) {
  const meta = HEALTH_META[node.health] ?? HEALTH_META.offline;
  const rel = node.lastHeartbeatAt ? relativeTime(node.lastHeartbeatAt) : 'never';
  return (
    <Tooltip
      title={
        node.lastHeartbeatAt
          ? `Last heartbeat ${new Date(node.lastHeartbeatAt).toLocaleString()}`
          : 'No heartbeat recorded'
      }
      arrow
    >
      <Chip
        icon={<meta.Icon />}
        label={`${meta.label} · ${rel}`}
        color={meta.color}
        size="small"
        variant="outlined"
        sx={{ cursor: 'help' }}
      />
    </Tooltip>
  );
}

const MAX_TYPE_CHIPS = 3;

/** Eligible job types as chips, truncated with a "+N" overflow chip. */
function EligibleTypes({ types }: { types: string[] }) {
  if (!types || types.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled">
        —
      </Typography>
    );
  }
  const shown = types.slice(0, MAX_TYPE_CHIPS);
  const overflow = types.length - shown.length;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {shown.map((t) => (
        <Chip key={t} label={t} size="small" variant="outlined" />
      ))}
      {overflow > 0 && (
        <Tooltip title={types.slice(MAX_TYPE_CHIPS).join(', ')} arrow>
          <Chip label={`+${overflow}`} size="small" variant="outlined" sx={{ cursor: 'help' }} />
        </Tooltip>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Worker node columns
// ---------------------------------------------------------------------------

/**
 * The eleven fleet columns.
 *
 * Priorities:
 *   - primary   — Node, Status
 *   - secondary — Heartbeat, Running, Failed
 *   - detail    — Platform, CLI version, Eligible types, Concurrency, Succeeded
 */
export function buildWorkerNodeColumns(): DataTableColumn<WorkerNodeDto>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'name',
      label: 'Node',
      priority: 'primary',
      value: (node) => node.name,
      render: (node) => (
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {node.name}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }} noWrap>
            {node.hostname}
          </Typography>
        </Box>
      ),
      minWidth: 180,
      flex: 1.2,
    },
    {
      id: 'status',
      label: 'Status',
      priority: 'primary',
      value: (node) => node.status,
      render: (node) => <StatusChip status={node.status} />,
      width: 120,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'health',
      label: 'Heartbeat',
      priority: 'secondary',
      value: (node) => node.health,
      render: (node) => <HeartbeatPill node={node} />,
      minWidth: 180,
    },
    {
      id: 'running',
      label: 'Running',
      priority: 'secondary',
      align: 'center',
      value: (node) => node.jobCounts.running,
      render: (node) => (
        <Typography variant="body2" color="info.main">
          {node.jobCounts.running}
        </Typography>
      ),
      width: 110,
    },
    {
      id: 'failed',
      label: 'Failed',
      priority: 'secondary',
      align: 'center',
      value: (node) => node.jobCounts.failed,
      render: (node) => (
        <Typography
          variant="body2"
          color={node.jobCounts.failed > 0 ? 'error.main' : 'text.secondary'}
        >
          {node.jobCounts.failed}
        </Typography>
      ),
      width: 110,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'succeeded',
      label: 'Succeeded',
      priority: 'detail',
      align: 'center',
      value: (node) => node.jobCounts.succeeded,
      render: (node) => (
        <Typography variant="body2" color="success.main">
          {node.jobCounts.succeeded}
        </Typography>
      ),
      width: 120,
    },
    {
      id: 'platform',
      label: 'Platform',
      priority: 'detail',
      value: (node) => node.platform,
      minWidth: 130,
    },
    {
      id: 'cliVersion',
      label: 'CLI Version',
      priority: 'detail',
      value: (node) => node.cliVersion,
      width: 130,
    },
    {
      id: 'eligibleTypes',
      label: 'Eligible Types',
      priority: 'detail',
      value: (node) => (node.eligibleTypes ?? []).join(', '),
      render: (node) => <EligibleTypes types={node.eligibleTypes} />,
      minWidth: 200,
      flex: 1,
    },
    {
      id: 'concurrency',
      label: 'Concurrency',
      priority: 'detail',
      align: 'center',
      value: (node) => node.concurrency,
      width: 130,
    },
  ];
}

// ---------------------------------------------------------------------------
// Node credential helpers + columns
// ---------------------------------------------------------------------------

export function isCredentialExpired(credential: AdminNodeCredentialDto): boolean {
  return !!credential.expiresAt && new Date(credential.expiresAt) < new Date();
}

export function isCredentialRevoked(credential: AdminNodeCredentialDto): boolean {
  return !!credential.revokedAt;
}

/** `Revoked` | `Expired` | `Active` — the scalar the Status column sorts/exports. */
export function credentialState(credential: AdminNodeCredentialDto): string {
  if (isCredentialRevoked(credential)) return 'Revoked';
  if (isCredentialExpired(credential)) return 'Expired';
  return 'Active';
}

/**
 * The eight credential columns.
 *
 * Priorities:
 *   - primary   — Name, Status
 *   - secondary — Prefix, Owner, Expires
 *   - detail    — Created, Last used
 *
 * The token PREFIX is all this endpoint ever returns (the raw token is shown
 * exactly once, at creation), so there is no secret to keep out of a CSV here —
 * unlike the share URL on the Public Sharing table.
 */
export function buildNodeCredentialColumns(): DataTableColumn<AdminNodeCredentialDto>[] {
  return [
    // --- primary ------------------------------------------------------------
    {
      id: 'name',
      label: 'Name',
      priority: 'primary',
      value: (credential) => credential.name,
      minWidth: 160,
      flex: 1,
    },
    {
      id: 'state',
      label: 'Status',
      priority: 'primary',
      value: credentialState,
      render: (credential) => {
        const revoked = isCredentialRevoked(credential);
        const expired = isCredentialExpired(credential);
        return (
          <Chip
            label={credentialState(credential)}
            color={revoked ? 'default' : expired ? 'warning' : 'success'}
            size="small"
            variant="outlined"
          />
        );
      },
      width: 120,
    },

    // --- secondary ----------------------------------------------------------
    {
      id: 'tokenPrefix',
      label: 'Prefix',
      priority: 'secondary',
      value: (credential) => credential.tokenPrefix,
      render: (credential) => (
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {credential.tokenPrefix}…
        </Typography>
      ),
      width: 140,
    },
    {
      id: 'ownerEmail',
      label: 'Owner',
      priority: 'secondary',
      value: (credential) => credential.ownerEmail,
      truncate: true,
      minWidth: 180,
    },
    {
      id: 'expiresAt',
      label: 'Expires',
      priority: 'secondary',
      value: (credential) => credential.expiresAt,
      render: (credential) =>
        credential.expiresAt ? (
          <Typography
            variant="body2"
            color={isCredentialExpired(credential) ? 'error.main' : 'text.secondary'}
            noWrap
          >
            {new Date(credential.expiresAt).toLocaleDateString()}
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Never
          </Typography>
        ),
      minWidth: 130,
    },

    // --- detail -------------------------------------------------------------
    {
      id: 'createdAt',
      label: 'Created',
      priority: 'detail',
      value: (credential) => credential.createdAt,
      render: (credential) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {relativeTime(credential.createdAt)}
        </Typography>
      ),
      minWidth: 140,
    },
    {
      id: 'lastUsedAt',
      label: 'Last used',
      priority: 'detail',
      value: (credential) => credential.lastUsedAt,
      render: (credential) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {credential.lastUsedAt ? relativeTime(credential.lastUsedAt) : '—'}
        </Typography>
      ),
      minWidth: 140,
    },
  ];
}
