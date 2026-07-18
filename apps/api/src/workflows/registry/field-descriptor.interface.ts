import { Prisma } from '@prisma/client';

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
 * Phase-1 action descriptor stub. The action LIBRARY (per-action parameter
 * schemas + execution) is Phase 2 (#140); Phase 1 only needs the registered
 * TYPE set so the validator can reject an unregistered action and
 * `GET /api/workflows/subjects` can advertise the catalog shape.
 */
export interface WorkflowActionDescriptor {
  type: string;
  label: string;
  /** Whether this action destroys data irreversibly (hard delete). Phase 2 gates it. */
  destructive?: boolean;
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
