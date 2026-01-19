import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';

/**
 * Request context stored in async local storage
 */
export interface RequestContext {
  requestId: string;
  traceId: string;
  userId?: string;
  startTime: number;
}

/**
 * Async local storage for request context propagation
 */
const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request context
 */
export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Get the current request ID
 */
export function getRequestId(): string | undefined {
  return asyncLocalStorage.getStore()?.requestId;
}

/**
 * Get the current trace ID
 */
export function getTraceId(): string | undefined {
  return asyncLocalStorage.getStore()?.traceId;
}

/**
 * Get the current user ID
 */
export function getUserId(): string | undefined {
  return asyncLocalStorage.getStore()?.userId;
}

/**
 * Set the user ID in the current context
 */
export function setUserId(userId: string): void {
  const context = asyncLocalStorage.getStore();
  if (context) {
    context.userId = userId;
  }
}

/**
 * Run a function with a new request context
 */
export function runWithRequestContext<T>(
  context: Partial<RequestContext>,
  fn: () => T
): T {
  const fullContext: RequestContext = {
    requestId: context.requestId ?? uuidv4(),
    traceId: context.traceId ?? uuidv4(),
    userId: context.userId,
    startTime: context.startTime ?? Date.now(),
  };
  return asyncLocalStorage.run(fullContext, fn);
}

/**
 * Get the elapsed time since request start
 */
export function getElapsedMs(): number {
  const context = asyncLocalStorage.getStore();
  if (!context) {
    return 0;
  }
  return Date.now() - context.startTime;
}
