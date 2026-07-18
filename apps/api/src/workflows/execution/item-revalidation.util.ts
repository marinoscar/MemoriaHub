import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CompiledWorkflow } from '../compiler/workflow-condition.compiler';

/**
 * Media Workflow Automation — per-item drift re-validation (issue #140).
 *
 * A workflow's preview/selection compiles to `CompiledWorkflow.where` (already
 * scoped `{ circleId, deletedAt: null }` + the definition's conditions) plus a
 * set of read-time `refinements` — exact predicates that a pure Prisma `where`
 * cannot express (see `workflow-condition.compiler.ts`).
 *
 * Between selection and execution an item's state can drift (a tag removed, a
 * date edited, an item archived), so before applying an action the engine
 * re-checks that ONE item still matches. This runs a cheap, indexed single-item
 * query (`AND: [{ id }, compiled.where]`) selecting only the columns the
 * refinement predicates need, then applies every predicate.
 *
 * Pure and dependency-light — takes a `PrismaService` or a transaction client
 * so it can run inside or outside a transaction.
 */
export async function revalidateItemMatches(
  prisma: PrismaService | Prisma.TransactionClient,
  compiled: CompiledWorkflow,
  itemId: string,
): Promise<boolean> {
  // Union every refinement's required columns into one select (plus id).
  const select: Prisma.MediaItemSelect = { id: true };
  for (const refinement of compiled.refinements) {
    Object.assign(select, refinement.select);
  }

  const row = await prisma.mediaItem.findFirst({
    where: { AND: [{ id: itemId }, compiled.where] },
    select,
  });

  // No row → the item no longer satisfies the bounding where (or is gone).
  if (!row) return false;

  // Every read-time refinement must also pass on the freshly-fetched row.
  for (const refinement of compiled.refinements) {
    if (!refinement.predicate(row)) return false;
  }

  return true;
}
