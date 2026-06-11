/**
 * sync/retry.ts — Thin helpers for retry selection.
 *
 * The core retry logic lives in SyncEngine.run() (retryFailedOnly path).
 * This module provides convenience helpers for commands that need to inspect
 * retry eligibility before calling the engine.
 */

import type { FileRepo } from '../repo/files.js';
import type { SettingsRepo } from '../repo/settings.js';
import type { FileRecord } from '../db/types.js';

export interface RetrySelection {
  /** Files eligible for retry (attempt_count < cap). */
  retryable: FileRecord[];
  /** Files blocked at cap — require --force to re-queue. */
  blocked: FileRecord[];
  /** The configured cap used for selection. */
  cap: number;
}

/**
 * Return the current retry selection for the given folders.
 * Does NOT mutate any DB state.
 */
export function getRetrySelection(
  files: FileRepo,
  settings: SettingsRepo,
  folderIds?: number[],
): RetrySelection {
  const cap = settings.attemptsCap();
  const retryable = files.listFailed({ folderIds, cap });
  const blocked   = files.listBlocked({ folderIds, cap });
  return { retryable, blocked, cap };
}
