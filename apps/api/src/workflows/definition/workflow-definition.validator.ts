import { BadRequestException, Injectable } from '@nestjs/common';
import {
  WorkflowDefinition,
  isGroupCondition,
  workflowDefinitionSchema,
} from './workflow-definition.schema';
import {
  WorkflowFieldDescriptor,
  WorkflowOperator,
} from '../registry/field-descriptor.interface';
import {
  getField,
  getSubjectRegistry,
  isRegisteredAction,
  isRegisteredSubject,
  registeredSubjects,
} from '../registry/subject-registry';

/**
 * Validates a workflow definition document against the per-Subject registry.
 *
 * Layered on top of the structural Zod schema: it rejects a `subject` not in the
 * registry, any `field`/`op`/action `type` not registered for that Subject, and
 * operator/value-type mismatches — so an unknown or cross-Subject combination
 * can never be persisted.
 *
 * Stateless and pure (no I/O) — trivially unit-testable.
 */
@Injectable()
export class WorkflowDefinitionValidator {
  /**
   * Parse + validate. Returns the normalized definition on success; throws
   * `BadRequestException` with actionable messages on any failure.
   */
  validate(input: unknown): WorkflowDefinition {
    // 1. Structural validation (version, subject present, nesting depth, shapes).
    const parsed = workflowDefinitionSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new BadRequestException(`Invalid workflow definition: ${issues}`);
    }
    const def = parsed.data;

    // 2. Subject must be registered.
    if (!isRegisteredSubject(def.subject)) {
      throw new BadRequestException(
        `Unknown workflow subject "${def.subject}". Registered subjects: ${registeredSubjects().join(', ')}`,
      );
    }

    // 3. Conditions: every field/op/value must be valid for the Subject.
    for (const cond of def.conditions) {
      if (isGroupCondition(cond)) {
        for (const leaf of cond.conditions) {
          this.validateLeaf(def.subject, leaf.field, leaf.op, leaf.value);
        }
      } else {
        this.validateLeaf(def.subject, cond.field, cond.op, cond.value);
      }
    }

    // 4. Actions: each type must be registered for the Subject (params: Phase 2).
    for (const action of def.actions) {
      if (!isRegisteredAction(def.subject, action.type)) {
        const registry = getSubjectRegistry(def.subject);
        const known = registry?.actions.map((a) => a.type).join(', ') ?? '';
        throw new BadRequestException(
          `Unknown action "${action.type}" for subject "${def.subject}". Registered actions: ${known}`,
        );
      }
    }

    return def;
  }

  /** Validate one leaf `{ field, op, value }` against its descriptor. */
  private validateLeaf(subject: string, field: string, op: string, value: unknown): void {
    const descriptor = getField(subject, field);
    if (!descriptor) {
      throw new BadRequestException(
        `Unknown field "${field}" for subject "${subject}"`,
      );
    }
    if (!descriptor.operators.includes(op as WorkflowOperator)) {
      throw new BadRequestException(
        `Operator "${op}" is not valid for field "${field}". Allowed: ${descriptor.operators.join(', ')}`,
      );
    }
    this.validateOperand(descriptor, op as WorkflowOperator, value);
  }

  /**
   * Validate that `value` matches the shape the (field, operator) pair expects.
   * The operator is the primary discriminator; enum membership is checked when
   * the descriptor declares `enumValues`.
   */
  private validateOperand(
    descriptor: WorkflowFieldDescriptor,
    op: WorkflowOperator,
    value: unknown,
  ): void {
    const fail = (msg: string): never => {
      throw new BadRequestException(`Field "${descriptor.key}" (op "${op}"): ${msg}`);
    };
    const isNonEmptyString = (v: unknown): v is string =>
      typeof v === 'string' && v.trim().length > 0;
    const inEnum = (v: unknown): boolean =>
      !!descriptor.enumValues && typeof v === 'string' && descriptor.enumValues.includes(v);

    switch (op) {
      case 'is':
        // Overloaded: enum fields (e.g. coordSource) take an enum member; all
        // other fields take a boolean.
        if (descriptor.enumValues) {
          if (!inEnum(value)) fail(`value must be one of: ${descriptor.enumValues.join(', ')}`);
        } else if (typeof value !== 'boolean') {
          fail('value must be a boolean');
        }
        return;

      case 'is_set':
        // No operand required.
        return;

      case 'equals':
        if (descriptor.enumValues) {
          if (!inEnum(value)) fail(`value must be one of: ${descriptor.enumValues.join(', ')}`);
        } else if (!isNonEmptyString(value)) {
          fail('value must be a non-empty string');
        }
        return;

      case 'contains':
      case 'starts_with':
      case 'ends_with':
        if (!isNonEmptyString(value)) fail('value must be a non-empty string');
        return;

      case 'gt':
      case 'lt':
      case 'gte':
        if (typeof value !== 'number' || !Number.isFinite(value)) fail('value must be a number');
        return;

      case 'before':
      case 'after':
        if (!isNonEmptyString(value) || isNaN(new Date(value).getTime())) {
          fail('value must be an ISO 8601 date string');
        }
        return;

      case 'older_than_days':
      case 'within_last_days':
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          fail('value must be a positive integer number of days');
        }
        return;

      case 'between': {
        const v = value as { from?: unknown; to?: unknown } | undefined;
        if (!v || typeof v !== 'object' || (v.from === undefined && v.to === undefined)) {
          fail('value must be an object { from?, to? } with at least one ISO date');
        }
        for (const bound of [v!.from, v!.to]) {
          if (bound !== undefined && (!isNonEmptyString(bound) || isNaN(new Date(bound).getTime()))) {
            fail('from/to must be ISO 8601 date strings');
          }
        }
        return;
      }

      case 'has_any':
      case 'has_all':
      case 'has_none': {
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          !value.every((x) => isNonEmptyString(x))
        ) {
          fail('value must be a non-empty array of strings');
        }
        return;
      }

      case 'has_person':
      case 'not_has_person': {
        const v = value as { ids?: unknown; mode?: unknown } | undefined;
        if (
          !v ||
          typeof v !== 'object' ||
          !Array.isArray(v.ids) ||
          v.ids.length === 0 ||
          !v.ids.every((x) => isNonEmptyString(x))
        ) {
          fail('value must be an object { ids: string[] } with a non-empty ids array');
        }
        if (v!.mode !== undefined && v!.mode !== 'any' && v!.mode !== 'all') {
          fail("mode must be 'any' or 'all' when provided");
        }
        return;
      }

      case 'in_album':
      case 'not_in_album':
        if (!isNonEmptyString(value)) fail('value must be an album UUID string');
        return;

      case 'near': {
        const v = value as { lat?: unknown; lng?: unknown; radiusKm?: unknown } | undefined;
        if (
          !v ||
          typeof v.lat !== 'number' ||
          typeof v.lng !== 'number' ||
          typeof v.radiusKm !== 'number' ||
          v.radiusKm <= 0
        ) {
          fail('value must be { lat, lng, radiusKm } numbers with radiusKm > 0');
        }
        return;
      }

      default:
        fail('unsupported operator');
    }
  }
}
