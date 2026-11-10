import { Injectable, Logger } from '@nestjs/common';

import type { ActionOutcome, WorkflowActionInstance, WorkflowActionContext, WorkflowActionItem } from './action-executor.types.js';

/**
 * Applies the actions of one or more types: the executor half of a registered workflow action (the descriptor,
 * with its params schema and permission, is registered with `registerWorkflowAction`).
 *
 * A handler owns no run-lifecycle state: it applies ONE action to ONE item and returns a structured outcome.
 * It reuses the owning slice's service methods verbatim (each performs its own per-circle role check and
 * super-admin bypass through `ctx.actorPermissions`).
 *
 * @extensionPoint registry
 * @stability experimental
 */
export interface WorkflowActionHandler {
  /** The action types this handler applies. */
  readonly types: readonly string[];

  /**
   * Applies one action to one item.
   *
   * @param action - the action (its registered `type` and schema-validated `params`).
   * @param item - the item.
   * @param ctx - the per-run context.
   */
  execute(action: WorkflowActionInstance, item: WorkflowActionItem, ctx: WorkflowActionContext): Promise<ActionOutcome>;

  /**
   * Releases a finished run's per-run cache, when the handler keeps one.
   *
   * @param runId - the run.
   */
  clearRunCache?(runId: string): void;
}

/**
 * The registry of action handlers, keyed by action type. Provided by `WorkflowsModule`; the owner of an action
 * (the web app for the item-level and review-queue actions today) injects it and registers a handler at start.
 *
 * @extensionPoint registry
 * @stability experimental
 */
@Injectable()
export class WorkflowActionHandlerRegistry {
  private readonly byType = new Map<string, WorkflowActionHandler>();

  private readonly handlers = new Set<WorkflowActionHandler>();

  /**
   * Registers a handler for each of its types. A type registered twice is replaced (a restarting test module
   * must not double it).
   *
   * @param handler - the handler.
   */
  register(handler: WorkflowActionHandler): void {
    this.handlers.add(handler);
    for (const type of handler.types) this.byType.set(type, handler);
  }

  /**
   * The handler of an action type.
   *
   * @param type - the action type.
   * @returns the handler, or undefined when none is registered.
   */
  find(type: string): WorkflowActionHandler | undefined {
    return this.byType.get(type);
  }

  /** Every registered handler. */
  all(): WorkflowActionHandler[] {
    return [...this.handlers];
  }
}

/**
 * Applies a single Media-Item workflow action (the "Then" half, issue #140) to a single item and returns a
 * structured outcome, by dispatching to the handler registered for the action's type.
 *
 * Thrown errors are caught and converted to `{ status: 'failed' }`; a handler that finds nothing to do answers
 * `{ status: 'skipped' }` with a reason. An action type with no handler is `failed` ("Unknown action type").
 *
 * @stability experimental
 */
@Injectable()
export class WorkflowActionExecutor {
  private readonly logger = new Logger(WorkflowActionExecutor.name);

  constructor(private readonly handlers: WorkflowActionHandlerRegistry) {}

  /**
   * Releases a finished run's per-run caches (called by the run engine).
   *
   * @param runId - the run.
   */
  clearRunCache(runId: string): void {
    for (const handler of this.handlers.all()) handler.clearRunCache?.(runId);
  }

  /**
   * Applies one action to one item.
   *
   * @param action - the action.
   * @param item - the item.
   * @param ctx - the per-run context.
   */
  async execute(action: WorkflowActionInstance, item: WorkflowActionItem, ctx: WorkflowActionContext): Promise<ActionOutcome> {
    const handler = this.handlers.find(action.type);
    if (!handler) return { status: 'failed', detail: `Unknown action type "${action.type}"` };
    try {
      return await handler.execute(action, item, ctx);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Action ${action.type} failed for item ${item.id} (run ${ctx.runId}): ${detail}`);
      return { status: 'failed', detail };
    }
  }
}
