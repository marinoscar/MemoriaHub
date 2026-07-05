import * as fs from 'fs';
import * as path from 'path';
import { OVERRIDE_FILENAME } from './override.js';

/**
 * Supported media file extensions → MIME type.
 *
 * The scan/sync/backup pipeline classifies a file as a **photo** or **video**
 * purely by whether its MIME here starts with `image/` or `video/`, so every
 * entry MUST use the correct prefix. Classification is by extension only (no
 * content sniffing). The goal is broad capture — modern AND legacy formats —
 * so nothing on an old device is silently skipped; downstream rendering
 * (thumbnails/EXIF) may be limited for exotic formats, but the file still
 * syncs and can be backed up. Keys are lowercase (the walker lowercases the
 * extension before lookup).
 */
export const MIME_BY_EXT: Record<string, string> = {
  // --- Images: common raster ---
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jif: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  dib: 'image/bmp',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  // --- Images: modern / HDR / next-gen ---
  heic: 'image/heic',
  heif: 'image/heif',
  hif: 'image/heic',
  avif: 'image/avif',
  jxl: 'image/jxl',
  jp2: 'image/jp2',
  j2k: 'image/jp2',
  jpf: 'image/jpx',
  jpx: 'image/jpx',
  // --- Images: editor / misc ---
  psd: 'image/vnd.adobe.photoshop',
  tga: 'image/x-tga',
  pcx: 'image/x-pcx',
  // --- Images: camera RAW ---
  dng: 'image/x-adobe-dng',
  cr2: 'image/x-canon-cr2',
  cr3: 'image/x-canon-cr3',
  crw: 'image/x-canon-crw',
  nef: 'image/x-nikon-nef',
  nrw: 'image/x-nikon-nrw',
  arw: 'image/x-sony-arw',
  srf: 'image/x-sony-srf',
  sr2: 'image/x-sony-sr2',
  orf: 'image/x-olympus-orf',
  rw2: 'image/x-panasonic-rw2',
  raw: 'image/x-panasonic-raw',
  raf: 'image/x-fuji-raf',
  pef: 'image/x-pentax-pef',
  dcr: 'image/x-kodak-dcr',
  kdc: 'image/x-kodak-kdc',
  mrw: 'image/x-minolta-mrw',
  '3fr': 'image/x-hasselblad-3fr',
  fff: 'image/x-hasselblad-fff',
  mef: 'image/x-mamiya-mef',
  mos: 'image/x-leaf-mos',
  iiq: 'image/x-phaseone-iiq',
  erf: 'image/x-epson-erf',
  x3f: 'image/x-sigma-x3f',
  srw: 'image/x-samsung-srw',
  rwl: 'image/x-leica-rwl',
  gpr: 'image/x-gopro-gpr',

  // --- Videos: modern containers ---
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  // --- Videos: legacy / camcorder / broadcast ---
  avi: 'video/x-msvideo',
  divx: 'video/divx',
  wmv: 'video/x-ms-wmv',
  asf: 'video/x-ms-asf',
  flv: 'video/x-flv',
  f4v: 'video/x-f4v',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  mpe: 'video/mpeg',
  m1v: 'video/mpeg',
  m2v: 'video/mpeg',
  mpv: 'video/mpeg',
  mp2: 'video/mpeg',
  vob: 'video/mpeg',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  mts: 'video/mp2t',
  m2ts: 'video/mp2t',
  m2t: 'video/mp2t',
  ts: 'video/mp2t',
  mxf: 'video/mxf',
  dv: 'video/dv',
  dif: 'video/dv',
  rm: 'video/vnd.rn-realvideo',
  rmvb: 'video/vnd.rn-realvideo',
  amv: 'video/x-amv',
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

      // The per-folder metadata override sidecar is never media — skip it
      // explicitly so it can never be enumerated for upload regardless of
      // extension mapping.
      if (entry.name === OVERRIDE_FILENAME) {
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
