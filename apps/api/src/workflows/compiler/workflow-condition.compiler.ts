import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WorkflowDependency,
  WorkflowOperator,
} from '../registry/field-descriptor.interface';
import { getField } from '../registry/subject-registry';
import {
  LeafCondition,
  WorkflowDefinition,
  isGroupCondition,
} from '../definition/workflow-definition.schema';

/**
 * A read-time refinement: an exact predicate that cannot be expressed as a pure
 * Prisma index predicate (see `media-item-fields.ts`). Collected by the compiler
 * ONLY when the refinement field sits on an all-AND path from the definition
 * root, which makes it sound to apply as a top-level AND post-filter. On any
 * OR-nested path the field contributes only its bounding predicate (an upper
 * bound), and no refinement is emitted.
 */
export interface CompiledRefinement {
  field: string;
  /** Extra columns the predicate needs selected on the fetched row. */
  select: Prisma.MediaItemSelect;
  predicate: (row: any) => boolean;
}

export interface CompiledWorkflow {
  /** Prisma where, scoped `{ circleId, deletedAt: null }` + compiled conditions. */
  where: Prisma.MediaItemWhereInput;
  /** Enrichment outputs the conditions read (Phase 4 evaluability gating). */
  dependencies: Set<WorkflowDependency>;
  /** Read-time refinements to apply after the where (see CompiledRefinement). */
  refinements: CompiledRefinement[];
}

/**
 * Compiles a validated workflow definition into a Prisma `where` (plus a
 * dependency set and read-time refinements), resolved per Subject through the
 * registry.
 *
 * Composition follows the search engine's shared-array rule: every condition is
 * pushed as its own element of an `AND` (match:'all') or `OR` (match:'any')
 * array — fragments are never merged into one object — so two descriptors that
 * each emit a top-level `OR`/`AND` key never collide (see
 * `docs/audits/search-audit.md`).
 */
@Injectable()
export class WorkflowConditionCompiler {
  /**
   * Compile a definition against a circle. Assumes the definition has already
   * passed `WorkflowDefinitionValidator` (fields/ops/values are valid).
   */
  compile(circleId: string, def: WorkflowDefinition): CompiledWorkflow {
    const dependencies = new Set<WorkflowDependency>();
    const refinements: CompiledRefinement[] = [];
    const rootPureAnd = def.match === 'all';

    const fragments: Prisma.MediaItemWhereInput[] = def.conditions.map((cond) => {
      if (isGroupCondition(cond)) {
        // A group is one nesting level; its leaves compile with the group's own
        // match. The group's leaves are on a pure-AND path only when BOTH the
        // root and the group use match:'all'.
        const groupPureAnd = rootPureAnd && cond.match === 'all';
        const groupFragments = cond.conditions.map((leaf) =>
          this.compileLeaf(def.subject, leaf, dependencies, refinements, groupPureAnd),
        );
        return cond.match === 'all' ? { AND: groupFragments } : { OR: groupFragments };
      }
      return this.compileLeaf(def.subject, cond, dependencies, refinements, rootPureAnd);
    });

    const where: Prisma.MediaItemWhereInput = { circleId, deletedAt: null };
    if (fragments.length > 0) {
      if (def.match === 'all') where.AND = fragments;
      else where.OR = fragments;
    }

    return { where, dependencies, refinements };
  }

  /**
   * Derive ONLY the dependency set for a definition without building a where —
   * cheaper and value-agnostic (never throws on operand issues). Exposed so the
   * service can surface `dependencies` per workflow. Silently skips unknown
   * fields (a validated definition has none).
   */
  deriveDependencies(def: WorkflowDefinition): WorkflowDependency[] {
    const deps = new Set<WorkflowDependency>();
    const addLeaf = (subject: string, leaf: LeafCondition) => {
      const descriptor = getField(subject, leaf.field);
      if (descriptor) deps.add(descriptor.dependency);
    };
    for (const cond of def.conditions) {
      if (isGroupCondition(cond)) {
        for (const leaf of cond.conditions) addLeaf(def.subject, leaf);
      } else {
        addLeaf(def.subject, cond);
      }
    }
    return [...deps];
  }

  private compileLeaf(
    subject: string,
    leaf: LeafCondition,
    dependencies: Set<WorkflowDependency>,
    refinements: CompiledRefinement[],
    pureAndPath: boolean,
  ): Prisma.MediaItemWhereInput {
    const descriptor = getField(subject, leaf.field);
    if (!descriptor) {
      // Should be unreachable post-validation; guard defensively.
      throw new BadRequestException(`Unknown field "${leaf.field}" for subject "${subject}"`);
    }
    dependencies.add(descriptor.dependency);

    const op = leaf.op as WorkflowOperator;

    // Collect a read-time refinement only when it is (a) evaluable in-process
    // and (b) on a pure-AND path (sound to AND post-filter). Otherwise the
    // bounding predicate from buildWhere is the only narrowing applied.
    if (descriptor.readTimeRefinement && descriptor.refinementPredicate && pureAndPath) {
      refinements.push({
        field: descriptor.key,
        select: descriptor.refinementSelect ?? {},
        predicate: descriptor.refinementPredicate(op, leaf.value),
      });
    }

    return descriptor.buildWhere(op, leaf.value);
  }
}
