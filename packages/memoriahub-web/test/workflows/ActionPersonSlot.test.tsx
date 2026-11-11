/**
 * The `assign_person` and `remove_person` actions pick their person through the
 * host's `workflows.personSelect` slot (people belong to a slice that has not moved
 * into the package yet): the editor hands the slot the active library, the stored
 * person and a setter that merges the choice into the action.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../utils/test-utils.js';
import { ActionParamEditor } from '../../src/workflows/ui/components/builder/ActionParamEditor.js';
import { WORKFLOW_PERSON_SELECT_SLOT } from '../../src/workflows/headless/slot-names.js';
import type { WorkflowPersonSelectSlotProps } from '../../src/workflows/ui/slots.js';
import type { WorkflowActionInstance } from '../../src/workflows/headless/types.js';

function PersonSlotStub({ circleId, value, onChange }: WorkflowPersonSelectSlotProps) {
  return (
    <button type="button" data-testid="person-slot" onClick={() => onChange('person-2')}>
      {`${circleId}:${value ?? 'none'}`}
    </button>
  );
}

describe.each(['assign_person', 'remove_person'])('ActionParamEditor (%s)', (type) => {
  it('renders the host slot with the library and the stored person, and merges the choice', async () => {
    const onChange = vi.fn();
    const action = { type, personId: 'person-1' } as WorkflowActionInstance;

    render(
      <ActionParamEditor circleId="circle-1" action={action} onChange={onChange} tags={[]} albums={[]} />,
      { wrapperOptions: { slots: { [WORKFLOW_PERSON_SELECT_SLOT]: PersonSlotStub } } },
    );

    expect(screen.getByTestId('person-slot')).toHaveTextContent('circle-1:person-1');
    await userEvent.click(screen.getByTestId('person-slot'));
    expect(onChange).toHaveBeenCalledWith({ type, personId: 'person-2' });
  });

  it('renders nothing for the person when the host registers no slot', () => {
    const { container } = render(
      <ActionParamEditor circleId="circle-1" action={{ type } as WorkflowActionInstance} onChange={vi.fn()} tags={[]} albums={[]} />,
    );
    expect(container.querySelector('[data-testid="person-slot"]')).toBeNull();
  });
});
