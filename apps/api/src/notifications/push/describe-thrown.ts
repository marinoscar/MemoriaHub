/**
 * A thrown value rendered for a log line or a persisted delivery error.
 *
 * MESSAGE ONLY, NEVER THE STACK: the result can be persisted
 * (`notification_deliveries.error`), and a stack frame can quote local values
 * such as a rendered notification body. A thrown non-Error is named by type
 * rather than stringified to the useless `[object Object]`.
 */
export function describeThrown(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return `Non-Error value thrown (${typeof err}).`;
}
