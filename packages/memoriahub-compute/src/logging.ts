/**
 * Pluggable, dependency-free logging seam for the compute package.
 *
 * This package must stay framework-agnostic (no NestJS imports), but the
 * original API utilities logged decode failures through a NestJS Logger.
 * Hosts (apps/api, apps/cli) call `setComputeLogger` once at startup to route
 * package-internal warnings/errors into their own logging stack; until then,
 * everything is a silent no-op — pure functions never write to stdout on
 * their own.
 */

/**
 * A log sink: takes one message and returns nothing.
 *
 * @stability stable
 */
export type ComputeLogFn = (message: string) => void;

/**
 * The logger the compute functions call for warnings and errors; the host injects its own with {@link setComputeLogger}.
 *
 * @stability stable
 */
export interface ComputeLogger {
  warn: ComputeLogFn;
  error: ComputeLogFn;
}

const noop: ComputeLogFn = () => {};

/**
 * Mutable singleton the compute modules log through.
 *
 * @stability stable
 */
export const computeLog: ComputeLogger = { warn: noop, error: noop };

/**
 * Wire the package's internal warnings/errors into the host's logger.
 *
 * @stability stable
 */
export function setComputeLogger(logger: Partial<ComputeLogger>): void {
  if (logger.warn) computeLog.warn = logger.warn;
  if (logger.error) computeLog.error = logger.error;
}
