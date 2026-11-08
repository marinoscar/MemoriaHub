/**
 * Admin → Settings → Database Backup (`/admin/settings/db-backup`).
 *
 * The platform's page (RETRO-D4, #580): the policy panel, the run history, download, cancel,
 * delete, and the restore/rollback dialog that renders the API's pre-flight gates (MemoriaHub's
 * `memoriahub-extensions` among them) exactly as returned. This file is the lazy-loaded binding:
 *
 *   - `DataTable`: the packaged responsive table (`@marinoscar/platform-web/datatable/ui`), handed in
 *     through `DbBackupWebAdaptersProvider`; the client is the package default over the platform host.
 *   - `Sections` (top): MemoriaHub's restore runbook link, always visible, as the app's page had it —
 *     the runbook is written for the moment this page is unreachable, so it is read before then.
 *
 * The registry card is spread from `dbBackupAdminSections` in `config/adminSections.tsx`; the route,
 * gated on the `db_backup:read` the API enforces, is in `App.tsx`.
 */
import { Alert, Link } from '@mui/material';
import { DataTable } from '@marinoscar/platform-web/datatable/ui';
import { DbBackupWebAdaptersProvider, type DbBackupWebAdapters } from '@marinoscar/platform-web/db-backup/headless';
import {
  DbBackupPage as PackagedDbBackupPage,
  type DbBackupPageSlots,
  type DbBackupSectionsProps,
} from '@marinoscar/platform-web/db-backup/ui';

/** Where MemoriaHub's manual, code-independent restore procedure lives. */
export const RESTORE_RUNBOOK_PATH = 'docs/runbooks/database-restore.md';
export const RESTORE_RUNBOOK_URL = `https://github.com/marinoscar/MemoriaHub/blob/main/${RESTORE_RUNBOOK_PATH}`;

/** The runbook link, under the header. Nothing at the bottom. */
export function RestoreRunbookSection({ position }: DbBackupSectionsProps) {
  if (position !== 'top') return null;
  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      Read the{' '}
      <Link href={RESTORE_RUNBOOK_URL} target="_blank" rel="noopener noreferrer">
        database restore runbook
      </Link>{' '}
      (<code>{RESTORE_RUNBOOK_PATH}</code>) now, not later: the situation it exists for is the one where this page is
      unreachable. Manual <code>pg_dump</code>/<code>pg_restore</code> commands must carry both{' '}
      <code>--enable-row-security</code> and <code>PGOPTIONS=-c app.rls_bypass=on</code>.
    </Alert>
  );
}

const SLOTS: DbBackupPageSlots = { Sections: RestoreRunbookSection };

/** A module constant: the provider keys on its identity. */
const ADAPTERS: DbBackupWebAdapters = { DataTable };

export default function DbBackupPage() {
  return (
    <DbBackupWebAdaptersProvider adapters={ADAPTERS}>
      <PackagedDbBackupPage slots={SLOTS} />
    </DbBackupWebAdaptersProvider>
  );
}
