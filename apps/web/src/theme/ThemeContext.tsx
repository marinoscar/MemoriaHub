import React, { createContext, useState, useMemo, useEffect, useCallback } from 'react';
import {
  ThemeProvider as MuiThemeProvider,
  createTheme,
  CssBaseline,
} from '@mui/material';
import { darkPalette, lightPalette } from './palette';
import { getComponentOverrides } from './components';

/**
 * Theme mode type
 */
export type ThemeMode = 'dark' | 'light';

/**
 * Theme context value
 */
export interface ThemeContextValue {
  /** Current theme mode */
  mode: ThemeMode;
  /** Toggle between dark and light mode */
  toggleTheme: () => void;
  /** Set specific theme mode */
  setTheme: (mode: ThemeMode) => void;
  /** Whether dark mode is active */
  isDarkMode: boolean;
}

/**
 * Theme context
 */
export const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * Local storage key for theme preference
 */
const THEME_STORAGE_KEY = 'memoriahub-theme-mode';

/**
 * Get initial theme mode from localStorage or default to dark
 */
function getInitialMode(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'dark';
  }
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'dark' || stored === 'light') {
    return stored;
  }
  return 'dark'; // Default to dark mode
}

/**
 * Theme provider props
 */
interface ThemeProviderProps {
  children: React.ReactNode;
}

/**
 * Theme provider component
 * Provides theme context and MUI theme to the app
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  const [mode, setMode] = useState<ThemeMode>(getInitialMode);

  // Persist theme preference to localStorage
  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  }, [mode]);

  // Toggle theme handler
  const toggleTheme = useCallback(() => {
    setMode((prevMode) => (prevMode === 'dark' ? 'light' : 'dark'));
  }, []);

  // Set theme handler
  const setTheme = useCallback((newMode: ThemeMode) => {
    setMode(newMode);
  }, []);

  // Create MUI theme based on current mode
  const theme = useMemo(
    () =>
      createTheme({
        palette: mode === 'dark' ? darkPalette : lightPalette,
        components: getComponentOverrides(mode),
        typography: {
          fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
          h1: {
            fontWeight: 500,
          },
          h2: {
            fontWeight: 500,
          },
          h3: {
            fontWeight: 500,
          },
        },
        shape: {
          borderRadius: 8,
        },
      }),
    [mode]
  );

  // Context value
  const contextValue = useMemo<ThemeContextValue>(
    () => ({
      mode,
      toggleTheme,
      setTheme,
      isDarkMode: mode === 'dark',
    }),
    [mode, toggleTheme, setTheme]
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      <MuiThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </ThemeContext.Provider>
  );
}
