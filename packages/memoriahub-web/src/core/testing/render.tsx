import { createTheme, ThemeProvider } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import { render } from '@testing-library/react';
import type { RenderOptions, RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { MemoriahubWebHostProvider } from '../headless/host.js';
import type { MemoriahubWebHost } from '../headless/host.js';

/**
 * Options of {@link renderWithMemoriahubHost}.
 *
 * @stability experimental
 */
export interface RenderWithMemoriahubHostOptions extends Omit<RenderOptions, 'wrapper'> {
  /** The MUI theme. Default: `createTheme()`. */
  theme?: Theme;
  /** The first location of the `MemoryRouter`. Default `/`. */
  route?: string;
}

/**
 * Renders `ui` the way a slice sees it in a host: inside `MemoriahubWebHostProvider`,
 * an MUI theme and a `MemoryRouter`.
 *
 * @param ui - the element under test.
 * @param host - the host, usually `createFakeMemoriahubWebHost().host`.
 * @param options - theme, first route and Testing Library options.
 * @returns Testing Library's render result.
 *
 * @stability experimental
 */
export function renderWithMemoriahubHost(
  ui: ReactElement,
  host: MemoriahubWebHost,
  options: RenderWithMemoriahubHostOptions = {},
): RenderResult {
  const { theme, route = '/', ...renderOptions } = options;
  const muiTheme = theme ?? createTheme();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoriahubWebHostProvider host={host}>
      <ThemeProvider theme={muiTheme}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </ThemeProvider>
    </MemoriahubWebHostProvider>
  );
  return render(ui, { wrapper: Wrapper, ...renderOptions });
}
