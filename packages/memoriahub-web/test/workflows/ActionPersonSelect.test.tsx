/**
 * The `assign_person` and `remove_person` actions pick their person with the
 * people slice's `WorkflowPersonSelect`: the editor hands it the active library,
 * the stored person and a setter that merges the choice into the action.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../utils/test-utils.js';
import { ActionParamEditor } from '../../src/workflows/ui/components/builder/ActionParamEditor.js';
import type { WorkflowActionInstance } from '../../src/workflows/headless/types.js';

// The picker is the people slice's; a stub keeps the test free of async calls.
vi.mock('../../src/people/ui/index.js', () => ({
  WorkflowPersonSelect: ({
    circleId,
    value,
    onChange,
  }: {
    circleId: string;
    value: string | undefined;
    onChange: (personId: string | undefined) => void;
  }) => (
    <button type="button" data-testid="person-slot" onClick={() => onChange('person-2')}>
      {`${circleId}:${value ?? 'none'}`}
    </button>
  ),
  PersonMultiSelect: () => null,
}));

describe.each(['assign_person', 'remove_person'])('ActionParamEditor (%s)', (type) => {
  it('renders the picker with the library and the stored person, and merges the choice', async () => {
    const onChange = vi.fn();
    const action = { type, personId: 'person-1' } as WorkflowActionInstance;

    render(
      <ActionParamEditor circleId="circle-1" action={action} onChange={onChange} tags={[]} albums={[]} />,
    );

    expect(screen.getByTestId('person-slot')).toHaveTextContent('circle-1:person-1');
    await userEvent.click(screen.getByTestId('person-slot'));
    expect(onChange).toHaveBeenCalledWith({ type, personId: 'person-2' });
  });
});
