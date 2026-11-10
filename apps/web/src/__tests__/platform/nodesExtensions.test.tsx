/**
 * The Worker Nodes page's app extension (RETRO-C2, #581): the "Local backup" row action opens the
 * app's Local Media Backup page for that node.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { WorkerNode } from '@marinoscar/platform-web/nodes/headless';

import { LocalBackupAction, appWorkersPageSlots, nodeBackupPath } from '../../platform/nodesExtensions';

const row = { id: '11111111-1111-4111-8111-111111111111', name: 'worker-one', hostname: 'host-a.example.test' } as WorkerNode;

describe('nodesExtensions', () => {
  it('points the Local backup action at the node\'s backup page', () => {
    render(
      <MemoryRouter>
        <LocalBackupAction row={row} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Local backup of worker-one' });
    expect(link).toHaveAttribute('href', `/admin/settings/workers/${row.id}/backup`);
    expect(nodeBackupPath(row.id)).toBe(`/admin/settings/workers/${row.id}/backup`);
  });

  it('hands the packaged page the row action as a stable slot', () => {
    expect(appWorkersPageSlots.RowActions).toBe(LocalBackupAction);
  });
});
