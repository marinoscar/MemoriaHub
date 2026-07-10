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

export type ComputeLogFn = (message: string) => void;

export interface ComputeLogger {
  warn: ComputeLogFn;
  error: ComputeLogFn;
}

const noop: ComputeLogFn = () => {};

/** Mutable singleton the compute modules log through. */
export const computeLog: ComputeLogger = { warn: noop, error: noop };

/** Wire the package's internal warnings/errors into the host's logger. */
export function setComputeLogger(logger: Partial<ComputeLogger>): void {
  if (logger.warn) computeLog.warn = logger.warn;
  if (logger.error) computeLog.error = logger.error;
}
