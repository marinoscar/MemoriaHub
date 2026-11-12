/**
 * The Jobs page binding (RETRO-C1, #575): the platform's page, plus the one queue-wide action the
 * platform does not know, "Repair missing thumbnails", in the page's toolbar slot.
 *
 * `@marinoscar/platform-web/jobs/ui` is module-mocked with a stand-in page that renders the
 * `Toolbar` slot; the platform's own page is covered by the package tests. What this file proves is
 * the binding: the slot is handed in, the button is shown only to someone who may use the endpoint
 * behind it (`jobs:write` for the page, `storage:delete_any` for the repair route), and it calls
 * `POST /api/admin/media/thumbnails/repair` and says what happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// Keep the rest of the platform entry (the admin section registry reads `jobsAdminSections` from it,
// and the host admin port now reaches that registry), and replace only the page.
vi.mock('@marinoscar/platform-web/jobs/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/jobs/ui')>()),
  JobsPage: ({ slots }: { slots?: { Toolbar?: () => JSX.Element } }) => {
    const Toolbar = slots?.Toolbar;
    return (
      <div data-testid="packaged-jobs-page">
        {Toolbar ? <Toolbar /> : null}
      </div>
    );
  },
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('@marinoscar/memoriahub-web/media/headless', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  repairThumbnails: vi.fn(),
}));

import JobsPage from '../../pages/Admin/JobsPage';
import { usePermissions } from '../../hooks/usePermissions';
import { repairThumbnails } from '@marinoscar/memoriahub-web/media/headless';

const mockUsePermissions = vi.mocked(usePermissions);
const mockRepair = vi.mocked(repairThumbnails);

function grant(...permissions: string[]) {
  mockUsePermissions.mockReturnValue({
    hasPermission: (permission: string) => permissions.includes(permission),
  } as ReturnType<typeof usePermissions>);
}

describe('Admin JobsPage binding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the platform page with the toolbar slot handed in', () => {
    grant('jobs:write', 'storage:delete_any');
    render(<JobsPage />);

    expect(screen.getByTestId('packaged-jobs-page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /repair missing thumbnails/i })).toBeInTheDocument();
  });

  it.each([
    ['jobs:write only', ['jobs:write']],
    ['storage:delete_any only', ['storage:delete_any']],
    ['neither', []],
  ])('hides the repair button for %s', (_label, permissions) => {
    grant(...permissions);
    render(<JobsPage />);

    expect(screen.queryByRole('button', { name: /repair missing thumbnails/i })).not.toBeInTheDocument();
  });

  it('queues a thumbnail repair and reports the job', async () => {
    grant('jobs:write', 'storage:delete_any');
    mockRepair.mockResolvedValue({ jobId: 'abcdef12-0000-4000-8000-000000000000', status: 'pending' });
    const user = userEvent.setup();
    render(<JobsPage />);

    await user.click(screen.getByRole('button', { name: /repair missing thumbnails/i }));

    await waitFor(() => expect(mockRepair).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Thumbnail repair queued \(job abcdef12/)).toBeInTheDocument();
  });

  it('surfaces a failure', async () => {
    grant('jobs:write', 'storage:delete_any');
    mockRepair.mockRejectedValue(new Error('403 Forbidden'));
    const user = userEvent.setup();
    render(<JobsPage />);

    await user.click(screen.getByRole('button', { name: /repair missing thumbnails/i }));

    expect(await screen.findByText('403 Forbidden')).toBeInTheDocument();
  });
});
