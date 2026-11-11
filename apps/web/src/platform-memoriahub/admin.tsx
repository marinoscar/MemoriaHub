/**
 * The admin port of the web edition's `MemoriahubWebHost` (RETRO-J11, #626): the
 * three platform-owned things the packaged admin pages of the domain slices ask
 * their host for. The data table is the platform's `DataTable` (loaded lazily, so
 * the grid stays out of the entry chunk exactly as it did when each admin page
 * imported it), the page header is the console's `AdminPageHeader` (one
 * declaration, so the "Back to Settings" rule stays in one place), and the
 * settings hook is the app's `useSystemSettings` over the platform settings slice.
 */
import { Suspense, lazy } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { DataTable as PlatformDataTable } from '@marinoscar/platform-web/datatable/ui';
import type {
  MemoriahubAdminPort,
  MemoriahubDataTableComponent,
  MemoriahubDataTableProps,
} from '@marinoscar/memoriahub-web/core/headless';

import { AdminPageHeader } from '../components/admin/AdminPageHeader';
import { useSystemSettings } from '../hooks/useSystemSettings';

/**
 * Compile-time proof that the platform's table accepts everything the package's
 * table contract can send it. Never called.
 */
export const assertPlatformDataTableFitsPort = (table: typeof PlatformDataTable): MemoriahubDataTableComponent => table;

const LazyDataTable = lazy(() =>
  import('@marinoscar/platform-web/datatable/ui').then((m) => ({
    default: m.DataTable as unknown as ComponentType<MemoriahubDataTableProps<unknown>>,
  })),
);

function AppDataTable<Row>(props: MemoriahubDataTableProps<Row>): ReactNode {
  return (
    <Suspense fallback={null}>
      <LazyDataTable {...(props as unknown as MemoriahubDataTableProps<unknown>)} />
    </Suspense>
  );
}

/** The admin port of the web edition. */
export const appMemoriahubAdmin: MemoriahubAdminPort = {
  DataTable: AppDataTable,
  AdminPageHeader,
  useSystemSettings,
};
