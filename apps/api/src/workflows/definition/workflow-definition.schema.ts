import { z } from 'zod';

/**
 * Structural Zod schema for a versioned, Subject-tagged workflow definition
 * document (epic #138 / issue #139).
 *
 * This schema enforces SHAPE only:
 *   - `version` and `subject` are mandatory.
 *   - `conditions` are leaves `{ field, op, value }` OR exactly ONE nesting level
 *     of groups `{ match, conditions: leaf[] }` — a group may not contain another
 *     group, so deeper nesting is rejected here.
 *   - `actions` are structurally validated (each has a `type`); per-action
 *     parameter schemas live with the action library in Phase 2 (#140).
 *
 * Registry-aware validation (subject registered, field/op/action registered for
 * the subject, operator/value-type match) is layered on top by
 * `WorkflowDefinitionValidator` — a Zod schema cannot know the per-Subject
 * catalog.
 */

/** A single leaf condition: `{ field, op, value? }`. */
export const leafConditionSchema = z
  .object({
    field: z.string().min(1),
    op: z.string().min(1),
    // Value shape is operator-dependent; validated by the registry validator.
    value: z.unknown().optional(),
  })
  .strict();

export type LeafCondition = z.infer<typeof leafConditionSchema>;

/**
 * A group condition: `{ match, conditions: leaf[] }`. Its `conditions` accept
 * ONLY leaves — this is what caps nesting at exactly one level.
 */
export const groupConditionSchema = z
  .object({
    match: z.enum(['all', 'any']),
    conditions: z.array(leafConditionSchema).min(1),
  })
  .strict();

export type GroupCondition = z.infer<typeof groupConditionSchema>;

/** A top-level condition is either a leaf or a (single-level) group. */
export const topConditionSchema = z.union([groupConditionSchema, leafConditionSchema]);

export type TopCondition = z.infer<typeof topConditionSchema>;

/**
 * An action: structurally `{ type, ...params }`. Extra params pass through
 * untouched in Phase 1 (Phase 2 validates them per action type).
 */
export const actionSchema = z
  .object({
    type: z.string().min(1),
  })
  .passthrough();

export type WorkflowAction = z.infer<typeof actionSchema>;

/** The full versioned, Subject-tagged definition document. */
export const workflowDefinitionSchema = z
  .object({
    version: z.literal(1),
    subject: z.string().min(1),
    match: z.enum(['all', 'any']),
    // An empty conditions array is allowed: it matches every (non-deleted) item
    // in the circle — a legitimate "apply to all" workflow.
    conditions: z.array(topConditionSchema).default([]),
    // Actions optional in Phase 1 (no execution); Phase 2 will require ≥1 to run.
    actions: z.array(actionSchema).default([]),
    options: z
      .object({
        maxItems: z.number().int().positive().optional(),
        requirePreview: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** Type guard: is this top-level condition a group (vs a leaf)? */
export function isGroupCondition(c: TopCondition): c is GroupCondition {
  return typeof c === 'object' && c !== null && 'match' in c && 'conditions' in c;
}
