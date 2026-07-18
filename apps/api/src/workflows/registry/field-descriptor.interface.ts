import { Prisma } from '@prisma/client';
import type { ZodTypeAny } from 'zod';

/**
 * Media Workflow Automation — condition (field) descriptor model.
 *
 * A workflow's Subject (v1: `media_item`) exposes a catalog of typed FIELDS.
 * Each field declares the operators it supports, the JSON value shape those
 * operators expect, the enrichment output it depends on (used by Phase 4 to
 * decide when an item is evaluable), and a pure `buildWhere` that compiles one
 * `{ field, op, value }` leaf into a `Prisma.MediaItemWhereInput` fragment.
 *
 * Every field MUST compile to an INDEXED or RELATION-based Prisma where-clause —
 * no full scans, no user-supplied regex (glob / "contains" → `ILIKE` only).
 *
 * A small number of fields cannot be expressed as a pure index predicate
 * (Postgres cannot compare two columns or do column arithmetic inside Prisma's
 * typed `where`, and duplicate-group confidence is computed at read time, not
 * persisted — see CLAUDE.md). Those fields set `readTimeRefinement: true`: their
 * `buildWhere` returns the tightest *bounding* predicate they can, and the exact
 * comparison is applied as a bounded read-time refinement by the compiler /
 * preview. See `media-item-fields.ts` for the specifics.
 */

export type WorkflowFieldGroup =
  | 'File'
  | 'Dates'
  | 'Location'
  | 'Tags'
  | 'People'
  | 'Media'
  | 'Organization'
  | 'Review';

/**
 * High-level control type — a hint for the builder UI on how to render the
 * value input for this field.
 */
export type WorkflowFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'date'
  | 'geo-radius'
  | 'tag-set'
  | 'person-set'
  | 'uuid';

/**
 * The JSON shape an operator's `value` is expected to take. Used by the
 * validator to reject operator/value-type mismatches.
 */
export type WorkflowValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'iso-date'
  | 'date-range'
  | 'positive-int'
  | 'string-list'
  | 'person-set'
  | 'geo-radius'
  | 'uuid'
  | 'none';

/**
 * The full operator vocabulary across all fields. Each descriptor advertises the
 * subset it accepts; the validator rejects any op not in that subset.
 */
export type WorkflowOperator =
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'equals'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'between'
  | 'before'
  | 'after'
  | 'older_than_days'
  | 'within_last_days'
  | 'is'
  | 'is_set'
  | 'has_any'
  | 'has_all'
  | 'has_none'
  | 'has_person'
  | 'not_has_person'
  | 'in_album'
  | 'not_in_album'
  | 'near';

/**
 * Which enrichment output a condition reads. Unioned by the compiler into the
 * workflow's dependency set (Phase 4 uses it to gate on-media-enriched runs).
 */
export type WorkflowDependency =
  | 'metadata'
  | 'tags'
  | 'faces'
  | 'bursts'
  | 'duplicates'
  | 'locationSuggestions';

export interface WorkflowFieldDescriptor {
  /** Stable field key referenced by a definition's `{ field }`. */
  key: string;
  /** Human-readable label for the builder form. */
  label: string;
  /** Grouping bucket for the builder form. */
  group: WorkflowFieldGroup;
  /** Control-type hint for the builder UI. */
  type: WorkflowFieldType;
  /** Operators this field accepts. */
  operators: WorkflowOperator[];
  /** Shape the operand value must take. */
  valueType: WorkflowValueType;
  /** Enum members (only meaningful when `type: 'enum'`). */
  enumValues?: string[];
  /** Enrichment output this condition reads. */
  dependency: WorkflowDependency;
  /**
   * When true, `buildWhere` returns only a BOUNDING predicate; the exact
   * comparison is applied as a read-time refinement (see interface docblock).
   */
  readTimeRefinement?: boolean;
  /**
   * For a `readTimeRefinement` field that is evaluable in-process (needs only
   * columns available on the row), a factory that returns a predicate over a
   * fetched row. `undefined` for refinement fields whose exact evaluation is a
   * heavier compute pass (e.g. `duplicateGroupConfidence`) and is deferred to
   * the Phase-2 executor — the bounding predicate is used in the meantime.
   */
  refinementSelect?: Prisma.MediaItemSelect;
  refinementPredicate?: (op: WorkflowOperator, value: unknown) => (row: any) => boolean;
  /**
   * Compile a single leaf condition into a Prisma where fragment. Pure — no I/O.
   * MUST NOT mutate shared state. Throws for an unsupported operator/value.
   */
  buildWhere(op: WorkflowOperator, value: unknown): Prisma.MediaItemWhereInput;
}

/**
 * Permission requirement for a workflow action, in a typed shape the
 * run-create / approval path consumes to decide who may schedule and run it.
 *
 * Encoding:
 *   - `circleRole` — the minimum per-circle role the actor must hold on the
 *     workflow's circle (always `'collaborator'` in v1).
 *   - `systemPerms` — system permission strings the actor must ALL hold
 *     (base is `['media:write']`; `hard_delete` also needs `'media:delete'`).
 *   - `gates` — system-settings feature-flag keys that must be enabled for the
 *     action to be schedulable (`hard_delete` → `['workflows.allowHardDelete']`).
 *   - `bothCircles` — when true the actor must satisfy `circleRole` +
 *     `systemPerms` on BOTH the source and the target circle
 *     (`move_to_circle`).
 *   - `extraPermForTrashVariant` — an extra system permission required ONLY
 *     when the action's `action` param is `'trash'` (the burst/duplicate
 *     resolve actions require `'media:delete'` to trash, not to archive).
 */
export interface WorkflowActionPermission {
  circleRole: 'collaborator';
  systemPerms: string[];
  gates?: string[];
  bothCircles?: boolean;
  extraPermForTrashVariant?: 'media:delete';
}

/**
 * Media Workflow Automation — action (the "Then" half) descriptor.
 *
 * Carries everything the engine needs to validate an action instance and the
 * run-create/approval path needs to authorize it, without any I/O:
 *   - `paramsSchema` — a Zod schema validating this action's `params`
 *     (`z.object({}).strict()` for no-param actions).
 *   - `permission` — the typed permission requirement (see above).
 *   - `triggerCompatibility` — `'manual_only'` for actions too destructive to
 *     run on an automatic trigger (`hard_delete`), `'all'` otherwise.
 *   - `reversible` / `highImpact` — advisory flags surfaced to the builder UI
 *     and the approval gate: `hard_delete` is non-reversible + high-impact;
 *     `move_to_circle` is reversible but high-impact (re-enrichment fan-out);
 *     everything else is reversible + not high-impact.
 *   - `destructive` — retained from Phase 1; `true` only for `hard_delete`.
 */
export interface WorkflowActionDescriptor {
  type: string;
  label: string;
  /** Whether this action destroys data irreversibly (hard delete). */
  destructive?: boolean;
  /** Per-action Zod schema for the action's `params`. */
  paramsSchema: ZodTypeAny;
  /** Typed permission requirement consumed by the run-create / approval path. */
  permission: WorkflowActionPermission;
  /** Which triggers may drive this action. */
  triggerCompatibility: 'manual_only' | 'all';
  /** Advisory: can the action be undone? */
  reversible: boolean;
  /** Advisory: does the action have outsized/expensive side effects? */
  highImpact: boolean;
}

/**
 * One Subject's complete registry entry: its field catalog, action catalog, and
 * the trigger options valid for it. v1 registers only `media_item`.
 */
export interface SubjectRegistryEntry {
  subject: string;
  label: string;
  triggers: string[];
  fields: WorkflowFieldDescriptor[];
  actions: WorkflowActionDescriptor[];
}
