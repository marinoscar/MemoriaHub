import { useContext } from 'react';
import { ThemeContext, type ThemeContextValue } from '../theme';

/**
 * Hook to access theme context
 * @returns Theme context value
 * @throws Error if used outside ThemeProvider
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);

  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }

  return context;
}
