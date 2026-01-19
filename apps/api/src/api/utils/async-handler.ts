/**
 * Async Handler Utility
 *
 * Wraps async Express route handlers to properly catch and forward errors.
 * This prevents unhandled promise rejections and satisfies ESLint's
 * no-misused-promises rule.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void> | void;

/**
 * Wraps an async route handler to catch errors and pass them to next()
 */
export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
