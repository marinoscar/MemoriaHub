import { defineHostSlot } from '../../core/ui/index.js';
import { WORKFLOW_PERSON_SELECT_SLOT } from '../headless/slot-names.js';

// =============================================================================
// Slots: the components of slices that have not moved into this package yet
// =============================================================================
//
// The `assign_person` and `remove_person` actions of a workflow pick one person,
// and people belong to a slice that has not moved yet. The host registers the
// picker under the name below (`slots` of `MemoriahubWebHost`); a host that
// registers none renders the action without it. The slot is deleted when the
// people slice moves into the package.
// =============================================================================

/**
 * Props of the single-person picker of a workflow action the host supplies.
 *
 * @stability experimental
 */
export interface WorkflowPersonSelectSlotProps {
  /** The owner scope id whose people are offered. */
  circleId: string;
  /** The chosen person id, `undefined` when none. */
  value: string | undefined;
  /** Called with the chosen person id, `undefined` when cleared. */
  onChange: (personId: string | undefined) => void;
}

/** The single-person picker of a workflow action, from the host. @stability experimental */
export const WorkflowPersonSelectSlot = defineHostSlot<WorkflowPersonSelectSlotProps>(WORKFLOW_PERSON_SELECT_SLOT);
