/**
 * tui/theme.ts — Claude-Code-style terminal palette and design tokens.
 *
 * All TUI components import colors and glyphs from here so the look is
 * consistent and easy to change in one place.  Chalk's level is already
 * gated by NO_COLOR / --no-color in index.ts before this module loads.
 */

import chalk from 'chalk';

// ---------------------------------------------------------------------------
// Semantic color functions
// ---------------------------------------------------------------------------

/** Primary teal/cyan — headings, active elements */
export const primary = chalk.cyan;

/** Success green — uploaded files, done states */
export const success = chalk.green;

/** Warning amber — retries, warnings */
export const warning = chalk.yellow;

/** Error red — failures */
export const error = chalk.red;

/** Dim gray — secondary text, separators */
export const dim = chalk.dim;

/** White — primary body text */
export const body = chalk.white;

/** Bold white — emphasis */
export const bold = chalk.bold;

/** Blue — skipped / informational */
export const info = chalk.blue;

/** Inverse — status bar segments */
export const inverse = chalk.inverse;

/** Cyan bold — banner title */
export const banner = chalk.cyanBright.bold;

// ---------------------------------------------------------------------------
// Brand banner palette
// ---------------------------------------------------------------------------

/**
 * MemoriaHub brand colors — the four loop hues from the app logo
 * (Google-Material blue / red / yellow / green). Used to tint the ASCII
 * "MemoriaHub" banner so the CLI matches the app's visual identity.
 */
export const BRAND_HEX = ['#4285F4', '#EA4335', '#FBBC05', '#34A853'] as const;

/**
 * Tint multi-line ASCII-art banner text with the brand palette, split into
 * four left-to-right vertical color bands so the wordmark cycles through the
 * logo's blue→red→yellow→green. Spaces are left untinted. Honors NO_COLOR /
 * --no-color automatically (chalk.level is gated in ui.ts before this loads).
 */
export function brandColorize(lines: string[]): string[] {
  const width = Math.max(1, ...lines.map((l) => l.length));
  const bands = BRAND_HEX.length;
  return lines.map((line) =>
    Array.from(line, (ch, col) => {
      if (ch === ' ') return ch;
      const band = Math.min(bands - 1, Math.floor((col / width) * bands));
      return chalk.hex(BRAND_HEX[band]).bold(ch);
    }).join(''),
  );
}

// ---------------------------------------------------------------------------
// Compound helpers
// ---------------------------------------------------------------------------

export const colors = {
  /** Box border color — cyan */
  border: chalk.cyan,
  /** Uploaded block fill — green */
  uploaded: chalk.green,
  /** Currently uploading — cyan */
  uploading: chalk.cyan,
  /** Queued (not yet started) — dim gray */
  queued: chalk.dim,
  /** Skipped (dedup / unchanged) — blue */
  skipped: chalk.blue,
  /** Failed — red */
  failed: chalk.red,
  /** Neutral header label */
  label: chalk.dim,
  /** Active row highlight */
  highlight: chalk.cyanBright,
} as const;

// ---------------------------------------------------------------------------
// Box border style (Ink uses this string)
// ---------------------------------------------------------------------------

export const BOX_BORDER = 'round' as const;

// ---------------------------------------------------------------------------
// Meter block characters
// ---------------------------------------------------------------------------

export const METER = {
  uploaded:  '█',   // solid — green
  uploading: '▓',   // dense — cyan
  queued:    '░',   // light — dim
  skipped:   '▒',   // medium — blue
  failed:    '✖',   // cross — red (1 cell wide in terminals)
  empty:     ' ',
} as const;

// ---------------------------------------------------------------------------
// General glyphs
// ---------------------------------------------------------------------------

export const GLYPHS = {
  check:    '✔',
  retry:    '↷',
  cross:    '✖',
  play:     '▶',
  bullet:   '•',
  arrow:    '→',
  ellipsis: '…',
} as const;

// ---------------------------------------------------------------------------
// Spinner frames (fallback if ink-spinner isn't usable)
// ---------------------------------------------------------------------------

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
