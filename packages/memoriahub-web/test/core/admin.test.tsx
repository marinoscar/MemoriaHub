import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  MemoriahubAdminPortMissingError,
  MemoriahubWebHostProvider,
  useMemoriahubAdmin,
} from '../../src/core/headless/index.js';
import type { MemoriahubDataTableColumn } from '../../src/core/headless/index.js';
import { createFakeMemoriahubWebHost, renderWithMemoriahubHost } from '../../src/core/testing/index.js';

interface Row {
  id: string;
  name: string;
}

const columns: MemoriahubDataTableColumn<Row>[] = [{ id: 'name', label: 'Name', priority: 'primary', value: (r) => r.name }];

function Harness({ rows, onDelete }: { rows: Row[]; onDelete: (row: Row) => void }) {
  const { DataTable, AdminPageHeader } = useMemoriahubAdmin();
  return (
    <>
      <AdminPageHeader title="Things" description="All of them" />
      <DataTable<Row>
        columns={columns}
        rows={rows}
        rowId={(r) => r.id}
        ariaLabel="Things table"
        emptyState={<span>Nothing here.</span>}
        rowActions={[
          {
            id: 'delete',
            label: 'Delete',
            destructive: true,
            confirm: { title: 'Delete thing?', description: (r) => `Remove ${r.name}`, confirmLabel: 'Remove' },
            onClick: onDelete,
          },
        ]}
      />
    </>
  );
}

describe('the admin port', () => {
  it('refuses an admin page in a host with no admin port', () => {
    const { host } = createFakeMemoriahubWebHost();
    const bare = { ...host, admin: undefined };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      renderHook(() => useMemoriahubAdmin(), {
        wrapper: ({ children }) => <MemoriahubWebHostProvider host={bare}>{children}</MemoriahubWebHostProvider>,
      }),
    ).toThrow(MemoriahubAdminPortMissingError);
    spy.mockRestore();
  });

  it('renders the host table, header and confirmation', async () => {
    const { host } = createFakeMemoriahubWebHost();
    const onDelete = vi.fn();
    renderWithMemoriahubHost(<Harness rows={[{ id: 'a', name: 'Alpha' }]} onDelete={onDelete} />, host);
    expect(screen.getByRole('heading', { level: 1, name: 'Things' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Things table' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Remove Alpha')).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onDelete).toHaveBeenCalledWith({ id: 'a', name: 'Alpha' });
  });

  it('shows the empty state', () => {
    const { host } = createFakeMemoriahubWebHost();
    renderWithMemoriahubHost(<Harness rows={[]} onDelete={vi.fn()} />, host);
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  it('serves and merge-patches the settings document, recording each patch', async () => {
    const fake = createFakeMemoriahubWebHost({ systemSettings: { features: { autoTagging: false }, workflows: { batchSize: 200 } } });
    const { result } = renderHook(() => fake.host.admin!.useSystemSettings());
    expect(result.current.settings?.workflows?.batchSize).toBe(200);
    await act(async () => {
      await result.current.updateSettings({ workflows: { maxConcurrentRuns: 3 } });
    });
    await waitFor(() => expect(result.current.settings?.workflows).toEqual({ batchSize: 200, maxConcurrentRuns: 3 }));
    expect(fake.admin.settingsUpdates).toEqual([{ workflows: { maxConcurrentRuns: 3 } }]);
    fake.admin.failNextUpdate('nope');
    await expect(result.current.updateSettings({ features: {} })).rejects.toThrow('nope');
  });
});
