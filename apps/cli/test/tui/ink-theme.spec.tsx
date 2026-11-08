/**
 * test/tui/ink-theme.spec.tsx  (RETRO-F4, #582)
 *
 * tui/ink.tsx resolves every colour a screen writes through the platform theme tokens:
 * `cyan` is `primary`, `red` is `error`, ...; a monochrome theme draws no colour; a theme
 * override recolours the TUI from one place.
 */
import { render, cleanup } from 'ink-testing-library';
import chalk from 'chalk';
import { TuiAppProvider, defaultTuiTheme, resolveTuiTheme } from '@marinoscar/platform-cli/tui';

import { Box, COLOR_TOKENS, Text, resolveColor } from '../../src/tui/ink.js';

afterEach(() => cleanup());

const mono = resolveTuiTheme({ noColor: true });

describe('resolveColor', () => {
  it('maps each colour name a screen writes onto its theme token', () => {
    const theme = { ...defaultTuiTheme, primary: 'P', success: 'S', warning: 'W', error: 'E', info: 'I', dim: 'D', accent: 'A' };
    expect(resolveColor(theme, 'cyan')).toBe('P');
    expect(resolveColor(theme, 'cyanBright')).toBe('P');
    expect(resolveColor(theme, 'green')).toBe('S');
    expect(resolveColor(theme, 'yellow')).toBe('W');
    expect(resolveColor(theme, 'red')).toBe('E');
    expect(resolveColor(theme, 'blue')).toBe('I');
    expect(resolveColor(theme, 'gray')).toBe('D');
    expect(resolveColor(theme, 'magenta')).toBe('A');
  });

  it('passes an unknown colour through, and keeps undefined undefined', () => {
    expect(resolveColor(defaultTuiTheme, '#4285F4')).toBe('#4285F4');
    expect(resolveColor(defaultTuiTheme, 'white')).toBe('white');
    expect(resolveColor(defaultTuiTheme, undefined)).toBeUndefined();
  });

  it('draws no colour at all under a monochrome theme', () => {
    for (const name of [...Object.keys(COLOR_TOKENS), '#fff', 'white']) expect(resolveColor(mono, name)).toBeUndefined();
  });
});

describe('Text and Box', () => {
  const level = chalk.level;
  beforeAll(() => {
    chalk.level = 3; // force colour so the escape sequences are observable
  });
  afterAll(() => {
    chalk.level = level;
  });
  // eslint-disable-next-line no-control-regex
  const hasColor = (s: string): boolean => /\x1B\[(3[0-7]|9[0-7]|38;)/.test(s);

  it('colours text with the token in a colour theme', () => {
    const { lastFrame } = render(
      <TuiAppProvider theme={defaultTuiTheme}>
        <Text color="red">failed</Text>
      </TuiAppProvider>,
    );
    expect(hasColor(lastFrame()!)).toBe(true);
  });

  it('emits no colour escape under the monochrome theme, borders included', () => {
    const { lastFrame } = render(
      <TuiAppProvider theme={mono}>
        <Box borderStyle="round" borderColor="cyan">
          <Text color="red" bold>failed</Text>
        </Box>
      </TuiAppProvider>,
    );
    expect(lastFrame()).toContain('failed');
    expect(hasColor(lastFrame()!)).toBe(false);
  });

  it('a theme override recolours the screens that wrote a colour name', () => {
    const recolored = { ...defaultTuiTheme, error: 'magenta' };
    const base = render(<TuiAppProvider theme={defaultTuiTheme}><Text color="red">x</Text></TuiAppProvider>).lastFrame();
    cleanup();
    const next = render(<TuiAppProvider theme={recolored}><Text color="red">x</Text></TuiAppProvider>).lastFrame();
    expect(next).not.toBe(base);
  });

  it('works without a provider (the default theme)', () => {
    const { lastFrame } = render(<Text color="green">ok</Text>);
    expect(lastFrame()).toContain('ok');
  });
});

