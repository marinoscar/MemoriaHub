import { StorageObject } from '@prisma/client';
import { Readable } from 'stream';

export const OBJECT_PROCESSOR = Symbol('OBJECT_PROCESSOR');

export interface ObjectProcessorResult {
  success: boolean;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface ObjectProcessor {
  /**
   * Unique name for this processor
   */
  readonly name: string;

  /**
   * Priority order (lower = earlier). Default: 100
   */
  readonly priority: number;

  /**
   * When true, a failure/exception from this processor records its error
   * metadata (_processing.<name>_error) but does NOT mark the whole object
   * failed; only non-optional processors flip the object to status='failed'.
   */
  readonly optional?: boolean;

  /**
   * Check if this processor can handle the given object
   */
  canProcess(object: StorageObject): boolean;

  /**
   * Process the object asynchronously
   * @param object The storage object metadata
   * @param getStream Function to get a fresh stream of the object content
   * @param priorResults Read-only snapshot of the metadata already produced by
   *   lower-priority processors in this same run, keyed by processor name
   *   (e.g. `priorResults['video-probe']`). Optional: callers that run a
   *   processor in isolation omit it, so a processor must tolerate its absence.
   *   It exists so a processor can reuse an expensive earlier result (the
   *   geocode processor reads video-probe coordinates instead of downloading
   *   and probing a multi-GB video a second time).
   * @returns Processing result with optional metadata
   */
  process(
    object: StorageObject,
    getStream: () => Promise<Readable>,
    priorResults?: Readonly<Record<string, unknown>>,
  ): Promise<ObjectProcessorResult>;
}
