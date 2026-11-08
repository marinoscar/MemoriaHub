import chalk from 'chalk';

/**
 * MemoriaHub brand colors — the four loop hues from the app logo
 * (Google-Material blue / red / yellow / green). Used to tint the ASCII
 * "MemoriaHub" banner (headless `printBanner`) and passed to the platform TUI as its
 * `brand` theme hues so the TUI banner matches the app's visual identity.
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
