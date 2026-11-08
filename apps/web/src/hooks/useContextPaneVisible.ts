/**
 * Is the shell's context pane showing beside the rail right now?
 *
 * The Collections and Review hub pages are the phone / tablet form of what the
 * desktop context pane shows, so they redirect into their first entry whenever
 * the pane is on screen (issue #392). Since RETRO-F1 (#571) the pane is the
 * packaged `ShellNavigationRail`'s, and it shows exactly when the rail is
 * EXPANDED: `lg` and up AND not collapsed by the viewer. The old app pane
 * ignored the collapse preference, so the hubs only checked `lg`; checking the
 * preference too keeps a collapsed desktop rail from redirecting the hub away
 * while no pane is there to replace it (a navigation dead end).
 *
 * The `up('lg')` read mirrors the packaged rail's own expanded-tier query; it
 * mounts no chrome (listed in `__tests__/config/breakpointGates.test.ts`).
 * While the stored preference loads the answer is `false`, so a hub never
 * redirects on a guess.
 */
import { useMediaQuery, useTheme } from '@mui/material';
import { useShellRailPreference } from '@marinoscar/platform-web/shell/headless';

export function useContextPaneVisible(): boolean {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('lg'));
  const { railCollapsed, isLoading } = useShellRailPreference();
  return isDesktop && !isLoading && !railCollapsed;
}
