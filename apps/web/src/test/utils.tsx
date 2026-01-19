/**
 * Test utilities for React component testing
 *
 * Provides custom render function with all providers wrapped
 */

import React, { ReactElement } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';

// Create a test theme (dark mode by default, matching app defaults)
const testTheme = createTheme({
  palette: {
    mode: 'dark',
  },
});

/**
 * All providers wrapper for testing
 */
interface AllProvidersProps {
  children: React.ReactNode;
}

function AllProviders({ children }: AllProvidersProps) {
  return (
    <BrowserRouter>
      <ThemeProvider theme={testTheme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </BrowserRouter>
  );
}

/**
 * Custom render function that wraps components with all necessary providers
 */
const customRender = (
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) => render(ui, { wrapper: AllProviders, ...options });

// Re-export everything from testing-library
export * from '@testing-library/react';

// Override render with custom render
export { customRender as render };
