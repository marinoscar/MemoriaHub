import * as fs from 'fs';
import * as path from 'path';

export const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
};

export interface SupportedFile {
  filePath: string;
  mimeType: string;
}

/**
 * Enumerate supported media files in a folder.
 * @param folderPath  Absolute or relative path to the folder.
 * @param recursive   If true, descend into sub-directories.
 * @returns  Tuple of [supported files, skipped file paths with warnings].
 */
export function enumerateFiles(
  folderPath: string,
  recursive: boolean,
): { supported: SupportedFile[]; skipped: string[] } {
  const supported: SupportedFile[] = [];
  const skipped: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(
        `Warning: cannot read directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) {
          walk(full);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name).replace('.', '').toLowerCase();
      const mimeType = MIME_BY_EXT[ext];
      if (mimeType) {
        supported.push({ filePath: full, mimeType });
      } else {
        skipped.push(full);
      }
    }
  }

  walk(path.resolve(folderPath));
  return { supported, skipped };
}
