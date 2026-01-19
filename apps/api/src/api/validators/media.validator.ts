/**
 * Media Validators
 *
 * Request validation middleware for media endpoints.
 */

import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import {
  initiateUploadSchema,
  completeUploadSchema,
  listMediaQuerySchema,
  listMediaByLibraryParamsSchema,
} from '@memoriahub/shared';
import { ValidationError } from '../../domain/errors/ValidationError.js';

/**
 * Helper to check if an error is a ZodError
 * Uses name check instead of instanceof to handle multiple Zod instances
 */
function isZodError(error: unknown): error is ZodError {
  return error instanceof Error && error.name === 'ZodError';
}

/**
 * Validate initiate upload request body
 */
export function validateInitiateUpload(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    initiateUploadSchema.parse(req.body);
    next();
  } catch (error) {
    if (isZodError(error)) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}

/**
 * Validate complete upload request body
 */
export function validateCompleteUpload(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    completeUploadSchema.parse(req.body);
    next();
  } catch (error) {
    if (isZodError(error)) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}

/**
 * Validate list media query parameters and path params
 */
export function validateListMediaQuery(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    // Validate path params (libraryId)
    listMediaByLibraryParamsSchema.parse(req.params);
    // Validate query params
    listMediaQuerySchema.parse(req.query);
    next();
  } catch (error) {
    if (isZodError(error)) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}
