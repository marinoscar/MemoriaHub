/**
 * convert/error-report.ts — Collect and persist per-file conversion errors.
 *
 * The ConvertEngine emits a CONVERT_FILE event with `action:'error'` and the
 * ffmpeg error message for every file that fails. Consumers (the headless
 * command and the TUI screen) collect those into `ConvertErrorEntry[]` and use
 * these helpers to (a) show a grouped on-screen summary and (b) write a full
 * per-file report to disk so a systematic failure can be diagnosed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { exportsDir } from '../paths.js';

export interface ConvertErrorEntry {
  filePath: string;
  error: string;
}

export interface ConvertErrorGroup {
  message: string;
  count: number;
  /** A few example file paths that hit this error. */
  examples: string[];
}

/**
 * Group errors by their message so 135 identical failures collapse into one
 * row with a count. Messages are normalized by stripping any leading source
 * path (ffmpeg often prefixes the offending file), then sorted by count desc.
 */
export function summarizeConvertErrors(
  entries: ConvertErrorEntry[],
  maxExamples = 3,
): ConvertErrorGroup[] {
  const byMessage = new Map<string, ConvertErrorGroup>();
  for (const { filePath, error } of entries) {
    const message = normalizeMessage(error);
    let group = byMessage.get(message);
    if (!group) {
      group = { message, count: 0, examples: [] };
      byMessage.set(message, group);
    }
    group.count++;
    if (group.examples.length < maxExamples) group.examples.push(filePath);
  }
  return [...byMessage.values()].sort((a, b) => b.count - a.count);
}

/**
 * Collapse volatile, per-file parts of an ffmpeg error so identical failures
 * group together: strip absolute paths and long digit runs.
 */
function normalizeMessage(error: string): string {
  return error
    .replace(/(?:[A-Za-z]:)?[/\\][^\s'"]+/g, '<path>')
    .replace(/\d{2,}/g, '<n>')
    .trim();
}

/**
 * Write a full per-file error report to `~/.memoriahub/exports/` and return its
 * absolute path. `timestamp` is injectable for deterministic tests; it defaults
 * to now.
 */
export function writeConvertErrorReport(
  entries: ConvertErrorEntry[],
  timestamp: Date = new Date(),
): string {
  const dir = exportsDir();
  fs.mkdirSync(dir, { recursive: true });

  const stamp = timestamp.toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(dir, `convert-errors-${stamp}.log`);

  const groups = summarizeConvertErrors(entries, 0);
  const lines: string[] = [];
  lines.push(`MemoriaHub convert — error report`);
  lines.push(`Generated: ${timestamp.toISOString()}`);
  lines.push(`Failed files: ${entries.length}`);
  lines.push('');
  lines.push('Summary (grouped by error):');
  for (const g of groups) {
    lines.push(`  ${g.count.toString().padStart(6)}  ${g.message}`);
  }
  lines.push('');
  lines.push('Per-file detail:');
  for (const { filePath, error } of entries) {
    lines.push(`- ${filePath}`);
    lines.push(`    ${error}`);
  }
  lines.push('');

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  return outPath;
}
