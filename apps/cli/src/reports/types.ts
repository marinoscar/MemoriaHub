/**
 * reports/types.ts — Shared contracts for the extensible reports registry.
 *
 * A report is the single source of truth for both the headless CLI (`compute`)
 * and the future Ink TUI (`render`, added later by the TUI agent). Every report
 * MUST implement `compute()`; `render` is optional and left undefined here.
 *
 * NOTE: React is imported type-only so the headless runtime never pulls React
 * into the module graph.
 */

import type BetterSqlite3 from 'better-sqlite3';
import type React from 'react';

/** Ambient context handed to every report at compute/render time. */
export interface ReportContext {
  db: BetterSqlite3.Database;
}

/** A tabular report result — the headless + `--json` source of truth. */
export interface ReportTable {
  columns: string[];
  rows: (string | number)[][];
  summary?: string;
}

/** A registered report definition. */
export interface ReportDef {
  id: string;
  label: string;
  description: string;
  /** Headless + `--json` source of truth. Always implemented. */
  compute(ctx: ReportContext): ReportTable;
  /**
   * OPTIONAL rich Ink view — added later by the TUI agent in the tui layer.
   * Left UNDEFINED on every report in the headless layer.
   */
  render?(ctx: ReportContext): React.ReactElement;
}
