/**
 * MemoriaHub's themes, built with the packaged `createShellTheme`
 * (`@marinoscar/platform-web/shell/headless`, RETRO-F1 #571): Inter, 600-weight
 * headings, an 8px radius, no-uppercase buttons, the flat AppBar with a
 * hairline border and the soft card shadow are the shell's (the same values
 * this app used to declare itself); the brand palettes below are the app's.
 */
import type { Theme } from '@mui/material/styles';
import { createShellTheme } from '@marinoscar/platform-web/shell/headless';
import { lightPalette } from './light';
import { darkPalette } from './dark';

export const lightTheme: Theme = createShellTheme('light', { palette: lightPalette });
export const darkTheme: Theme = createShellTheme('dark', { palette: darkPalette });

/** What `ShellRoot` / `ShellThemeProvider` resolve the viewer's mode against. */
export const APP_THEMES = { light: lightTheme, dark: darkTheme };

export type ThemeMode = 'light' | 'dark' | 'system';
