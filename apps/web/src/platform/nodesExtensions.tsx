// =============================================================================
// The packaged Worker Nodes page's app extension (RETRO-C2, #581)
// =============================================================================
//
// `/admin/settings/workers` is the nodes slice's `WorkersPage`. The one thing MemoriaHub adds to it
// is the Local Media Backup (epic #308), which stays an app page: a per-node row action ("Local
// backup") through the page's `RowActions` slot (the pattern of the platform's
// `CopyHostnameAction` example) links to `/admin/settings/workers/:id/backup`. The slot receives
// the row, never an API client; the backup page does its own reads, behind the same admin gate as
// before.
// =============================================================================

import type { ReactElement } from 'react';
import { Button } from '@mui/material';
import SaveAltIcon from '@mui/icons-material/SaveAlt';
import { Link as RouterLink } from 'react-router-dom';
import type { WorkerNode } from '@marinoscar/platform-web/nodes/headless';
import type { WorkersPageSlots } from '@marinoscar/platform-web/nodes/ui';

/** The path of a node's Local Media Backup page. */
export function nodeBackupPath(nodeId: string): string {
  return `/admin/settings/workers/${nodeId}/backup`;
}

/** "Local backup": opens the node's Local Media Backup page. */
export function LocalBackupAction({ row }: { row: WorkerNode }): ReactElement {
  return (
    <Button
      size="small"
      component={RouterLink}
      to={nodeBackupPath(row.id)}
      startIcon={<SaveAltIcon fontSize="small" />}
      aria-label={`Local backup of ${row.name}`}
    >
      Local backup
    </Button>
  );
}

/** The slots MemoriaHub hands the packaged page. A module constant: the page keys on its identity. */
export const appWorkersPageSlots: WorkersPageSlots = {
  RowActions: LocalBackupAction,
};
