import type { ComponentType } from 'react';
import type { WorkflowDefinition, WorkflowTriggerType } from '../types.js';

// ---------------------------------------------------------------------------
// Ready-made workflow templates surfaced in the templates gallery. These are
// pure client-side constants; selecting one pre-fills the builder (see the
// template hydration contract in WorkflowBuilderPage). Each `definition` is a
// full, valid backend definition (version 1, subject 'media_item') with action
// params as TOP-LEVEL siblings of `type`.
// ---------------------------------------------------------------------------

/**
 * Workflow Template.
 *
 * @stability experimental
 */
export interface WorkflowTemplate {
  /** The `id`. */
  id: string;
  /** The `name`. */
  name: string;
  /** The `title`. */
  title: string;
  /** The `description`. */
  description: string;
  /** The `plainLanguage`. */
  plainLanguage: string;
  /** The `icon`. */
  icon: ComponentType<{ color?: 'primary' }>;
  /** The `suggestedTrigger`. */
  suggestedTrigger: WorkflowTriggerType;
  /** The `suggestedCron`. */
  suggestedCron?: string | null;
  /** The `definition`. */
  definition: WorkflowDefinition;
}
