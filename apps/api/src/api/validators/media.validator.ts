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
  shareMediaSchema,
  bulkUpdateMediaMetadataSchema,
  bulkDeleteMediaSchema,
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
    // Only validate path params if libraryId exists (it's optional now)
    if (req.params.libraryId) {
      listMediaByLibraryParamsSchema.parse(req.params);
    }
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

/**
 * Validate share media request body
 */
export function validateShareMedia(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    shareMediaSchema.parse(req.body);
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
 * Validate bulk update metadata request body
 */
export function validateBulkUpdateMetadata(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    bulkUpdateMediaMetadataSchema.parse(req.body);
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
 * Validate bulk delete request body
 */
export function validateBulkDelete(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  try {
    bulkDeleteMediaSchema.parse(req.body);
    next();
  } catch (error) {
    if (isZodError(error)) {
      next(ValidationError.fromZodError(error));
      return;
    }
    next(error);
  }
}
