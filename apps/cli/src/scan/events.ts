/**
 * scan/events.ts — Typed event contract for the ScanEngine.
 *
 * Mirrors sync/events.ts: the engine emits typed events consumed by renderers
 * (headless CLI or Ink TUI).  The engine itself never touches the terminal.
 */

import { EventEmitter } from 'node:events';
import type { MediaKind } from '../db/types.js';

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

export const SCAN_EV = {
  SCAN_START:    'scan:start',
  FOLDER_START:  'scan:folder:start',
  FILE_SCANNED:  'scan:file',
  SCAN_PROGRESS: 'scan:progress',
  SCAN_DONE:     'scan:done',
  ERROR:         'scan:error',
} as const;

export type ScanEventName = typeof SCAN_EV[keyof typeof SCAN_EV];

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface ScanStartPayload {
  scanId: number;
  folderIds: number[];
}

export interface ScanFolderStartPayload {
  folderId: number;
  path: string;
  fileCount: number;
}

export interface ScanFileScannedPayload {
  folderId: number;
  path: string;
  mediaKind: MediaKind;
  sizeBytes: number | null;
  hasExif: boolean;
  hasGps: boolean;
  /** Non-null when metadata extraction failed for this file. */
  error: string | null;
}

export interface ScanProgressPayload {
  scanned: number;
  total: number;
}

export interface ScanTotalsPayload {
  totalFiles: number;
  totalBytes: number;
  photoCount: number;
  videoCount: number;
  exifCount: number;
  gpsCount: number;
}

export interface ScanDonePayload {
  scanId: number;
  totals: ScanTotalsPayload;
  durationMs: number;
}

export interface ScanErrorPayload {
  message: string;
}

// ---------------------------------------------------------------------------
// Typed EventEmitter wrapper
// ---------------------------------------------------------------------------

export interface ScanEngineEvents {
  [SCAN_EV.SCAN_START]:    (payload: ScanStartPayload)        => void;
  [SCAN_EV.FOLDER_START]:  (payload: ScanFolderStartPayload)  => void;
  [SCAN_EV.FILE_SCANNED]:  (payload: ScanFileScannedPayload)  => void;
  [SCAN_EV.SCAN_PROGRESS]: (payload: ScanProgressPayload)     => void;
  [SCAN_EV.SCAN_DONE]:     (payload: ScanDonePayload)         => void;
  [SCAN_EV.ERROR]:         (payload: ScanErrorPayload)        => void;
}

/**
 * ScanTypedEmitter — a thin typed wrapper over Node's EventEmitter for the
 * scan event set.  Provides type-safe on/off/once/emit.
 */
export class ScanTypedEmitter extends EventEmitter {
  on<K extends ScanEventName>(event: K, listener: ScanEngineEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends ScanEventName>(event: K, listener: ScanEngineEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  once<K extends ScanEventName>(event: K, listener: ScanEngineEvents[K]): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends ScanEventName>(
    event: K,
    payload: Parameters<ScanEngineEvents[K]>[0],
  ): boolean {
    return super.emit(event, payload);
  }
}
