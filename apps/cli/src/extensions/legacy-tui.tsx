// PLATFORM-ADOPTION-SHIM(RETRO-F4): the bridge from the platform TUI to the 1.3 MemoriaHub
// TUI. RETRO-F4 re-hosts the MemoriaHub screens on the platform TUI and deletes this file.
import { Text, useApp } from 'ink';
import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { requestLegacyTui } from './legacy-tui-request.js';

// =============================================================================
// The legacy MemoriaHub TUI, reachable from the platform menu  (issue #577)
// =============================================================================
//
// Until RETRO-F4 re-hosts them, MemoriaHub's own screens (sync, backup, worker
// node dashboard, ...) live in the 1.3 ink application (`src/tui/app.tsx`).
// A bare `memoriahub` in a terminal opens the platform's menu; its
// "MemoriaHub menu" entry is this screen. Two ink applications cannot share a
// terminal, so the screen only records the request and unmounts the platform
// TUI (`useApp().exit()` runs every cleanup); `runApp` then launches the legacy
// TUI once `cli.run` has returned and the terminal is restored.
// =============================================================================

/** The platform TUI screen: asks to hand the terminal to the legacy TUI. */
export function LegacyTuiBridge(): ReactElement {
  const { exit } = useApp();
  useEffect(() => {
    requestLegacyTui();
    exit();
  }, [exit]);
  return <Text dimColor>Opening the MemoriaHub menu…</Text>;
}

