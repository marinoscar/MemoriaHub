/**
 * tui/ink.tsx — `ink`, with every colour resolved through the platform theme
 * (RETRO-F4, #582). The MemoriaHub screens import `Box` and `Text` from here instead of
 * from `ink`; everything else (`useInput`, `useApp`, `Static`, ...) is ink's own.
 *
 * The 1.3 TUI kept its palette in `tui/theme.ts` and wrote ink colour names (`cyan`, `red`,
 * `green`, ...) at ~450 sites. The platform TUI has a theme of colour TOKENS
 * (`primary`, `success`, `warning`, `error`, `info`, `dim`, `accent`) that an app overrides once
 * (`createCli({ tuiTheme })`) and that is colourless under `NO_COLOR`, `--no-color` and
 * `TERM=dumb`. This adapter maps each colour name a screen writes onto its token, so:
 *   - a theme override recolours the whole TUI from one place,
 *   - a monochrome theme draws no colour at all (meaning is always carried by a glyph or a label),
 *   - a screen keeps writing `<Text color="red">`, which reads as intent and needs no hook.
 * A colour that is not one of the names below (a hex value, `white`, `cyanBright`'s bright variant
 * aside) passes through unchanged unless the theme is monochrome.
 */
import { Box as InkBox, Text as InkText } from 'ink';
import type { BoxProps, TextProps } from 'ink';
import type { PropsWithChildren, ReactElement } from 'react';
import { useTuiTheme, type TuiTheme } from '@marinoscar/platform-cli/tui';

export * from 'ink';

type Token = 'primary' | 'success' | 'warning' | 'error' | 'info' | 'dim' | 'accent';

/** The ink colour names the 1.3 screens used, and the theme token each one means. */
export const COLOR_TOKENS: Readonly<Record<string, Token>> = {
  cyan: 'primary',
  cyanBright: 'primary',
  green: 'success',
  yellow: 'warning',
  red: 'error',
  blue: 'info',
  gray: 'dim',
  grey: 'dim',
  magenta: 'accent',
};

/**
 * The colour to draw for `color` under `theme`: `undefined` when the theme is monochrome, the token's
 * colour for a known name, else the value unchanged.
 */
export function resolveColor(theme: TuiTheme, color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  if (!theme.color) return undefined;
  const token = COLOR_TOKENS[color];
  return token === undefined ? color : theme[token];
}

/** ink's `Text`, with `color` and `backgroundColor` resolved through the theme. */
export function Text(props: PropsWithChildren<TextProps>): ReactElement {
  const theme = useTuiTheme();
  const { color, backgroundColor, ...rest } = props;
  const fg = resolveColor(theme, color);
  const bg = resolveColor(theme, backgroundColor);
  return <InkText {...rest} {...(fg !== undefined ? { color: fg } : {})} {...(bg !== undefined ? { backgroundColor: bg } : {})} />;
}

/** ink's `Box`, with its border colour resolved through the theme. */
export function Box(props: PropsWithChildren<BoxProps>): ReactElement {
  const theme = useTuiTheme();
  const { borderColor, ...rest } = props;
  const color = resolveColor(theme, borderColor);
  return <InkBox {...rest} {...(color !== undefined ? { borderColor: color } : {})} />;
}
