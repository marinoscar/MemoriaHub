/**
 * The viewer's light / dark / system choice — a binding of the packaged
 * `ShellThemeProvider` (`@marinoscar/platform-web/shell/ui`, RETRO-F1 #571).
 *
 * The provider owns the choice (stored under the same `theme_mode`
 * localStorage key as before), the `prefers-color-scheme` resolution and the
 * AppBar's toggle. `useThemeContext` stays as the app's accessor so
 * `useUserSettings` can apply a stored `theme` setting through `setMode`.
 */
import type { ReactNode } from 'react';
import { ShellThemeProvider } from '@marinoscar/platform-web/shell/ui';
import { useOptionalShellTheme } from '@marinoscar/platform-web/shell/headless';
import type { ShellThemeContextValue } from '@marinoscar/platform-web/shell/headless';
import { APP_THEMES } from '../theme';

export const THEME_STORAGE_KEY = 'theme_mode';

export function ThemeContextProvider({ children }: { children: ReactNode }) {
  return (
    <ShellThemeProvider themes={APP_THEMES} storageKey={THEME_STORAGE_KEY}>
      {children}
    </ShellThemeProvider>
  );
}

export function useThemeContext(): ShellThemeContextValue {
  const context = useOptionalShellTheme();
  if (!context) {
    throw new Error('useThemeContext must be used within a ThemeContextProvider');
  }
  return context;
}
