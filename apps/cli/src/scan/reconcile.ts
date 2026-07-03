/**
 * scan/reconcile.ts — Diff a stored scan snapshot against the live filesystem.
 *
 * A scan captures a point-in-time snapshot of a folder set.  Between scan time
 * and a later `sync --scan`, files may have been added, removed, or modified.
 * reconcileScan re-enumerates the scan's folders and buckets the differences so
 * `sync` can surface "changes since scan" drift and guarantee nothing the scan
 * saw — or anything new since — is silently missed.
 *
 * Change detection uses size + mtime, the same signal sync's own fast-skip and
 * hash-cache already trust.  Pure and UI-free.
 */

import * as fs from 'node:fs';
import { enumerateFiles } from '../files.js';
import type { ScanRepo } from '../repo/scans.js';
import type { FolderRepo } from '../repo/folders.js';

export interface ScanDrift {
  scanId: number;
  /** Live files not present in the snapshot. */
  added: string[];
  /** Snapshot files no longer present live. */
  removed: string[];
  /** Files present in both whose size or mtime changed. */
  modified: string[];
  /** Count of files present in both and unchanged. */
  unchanged: number;
}

interface StatInfo {
  size: number | null;
  mtime: number | null;
}

/**
 * Reconcile a scan against the current state of its folders.
 *
 * @throws if the scan ID does not exist.
 */
export function reconcileScan(
  scans: ScanRepo,
  folders: FolderRepo,
  scanId: number,
): ScanDrift {
  const scan = scans.getScan(scanId);
  if (!scan) {
    throw new Error(`Scan ${scanId} not found.`);
  }

  // Snapshot: path → {size, mtime} from the persisted scan_files rows.
  const snapshot = new Map<string, StatInfo>();
  for (const f of scans.listScanFiles(scanId)) {
    snapshot.set(f.file_path, { size: f.size_bytes, mtime: f.mtime_ms });
  }

  // Live: re-enumerate the scan's folders and stat each supported file.
  let folderIds: number[] = [];
  try {
    folderIds = JSON.parse(scan.folder_ids) as number[];
  } catch {
    folderIds = [];
  }

  const live = new Map<string, StatInfo>();
  for (const folderId of folderIds) {
    const folder = folders.getById(folderId);
    if (!folder) continue;
    const { supported } = enumerateFiles(folder.path, folder.recursive);
    for (const { filePath } of supported) {
      let size: number | null = null;
      let mtime: number | null = null;
      try {
        const st = fs.statSync(filePath);
        size = st.size;
        mtime = Math.round(st.mtimeMs);
      } catch {
        // Disappeared mid-enumeration; record with null stat.
      }
      live.set(filePath, { size, mtime });
    }
  }

  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  let unchanged = 0;

  for (const [path, liveStat] of live) {
    const snap = snapshot.get(path);
    if (!snap) {
      added.push(path);
    } else if (snap.size !== liveStat.size || snap.mtime !== liveStat.mtime) {
      modified.push(path);
    } else {
      unchanged++;
    }
  }
  for (const path of snapshot.keys()) {
    if (!live.has(path)) removed.push(path);
  }

  return { scanId, added, removed, modified, unchanged };
}
