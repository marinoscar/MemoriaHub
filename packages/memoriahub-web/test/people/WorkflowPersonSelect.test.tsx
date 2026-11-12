/**
 * WorkflowPersonSelect: the single-person picker of the `assign_person` and
 * `remove_person` workflow actions (the host's `workflows.personSelect` slot of the
 * packaged builder). Only labelled people are offered, and clearing reports `undefined`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils.js';

vi.mock('../../src/people/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/people/headless/index.js')>()),
  usePeople: vi.fn(),
}));

import { WorkflowPersonSelect } from '../../src/people/ui/components/WorkflowPersonSelect.js';
import { usePeople } from '../../src/people/headless/index.js';

const mockUsePeople = vi.mocked(usePeople);

function person(id: string, name: string | null) {
  return { id, name, isUnlabeled: name == null, faceCount: 1, coverFace: null, createdAt: '', updatedAt: '', favorite: false };
}

describe('WorkflowPersonSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePeople.mockReturnValue({
      data: {
        items: [person('p-1', 'Alice'), person('p-2', null), person('p-3', 'Bob')],
        meta: { page: 1, pageSize: 100, totalItems: 3, totalPages: 1 },
      },
      loading: false,
      error: null,
    } as any);
  });

  it('loads the people of the library and shows the stored person', () => {
    render(<WorkflowPersonSelect circleId="circle-1" value="p-1" onChange={vi.fn()} />);

    expect(mockUsePeople).toHaveBeenCalledWith('circle-1');
    expect(screen.getByLabelText('Person')).toHaveValue('Alice');
  });

  it('offers only labelled people and reports the chosen id', async () => {
    const onChange = vi.fn();
    render(<WorkflowPersonSelect circleId="circle-1" value={undefined} onChange={onChange} />);

    await userEvent.click(screen.getByLabelText('Person'));
    expect(screen.queryByRole('option', { name: /^p-2/ })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('option', { name: 'Bob' }));

    expect(onChange).toHaveBeenCalledWith('p-3');
  });
});
