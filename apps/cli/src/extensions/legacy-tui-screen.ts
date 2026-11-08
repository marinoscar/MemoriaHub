// PLATFORM-ADOPTION-SHIM(RETRO-F4): removed with the bridge in legacy-tui.tsx.
import type { TuiScreenRegistration } from '@marinoscar/platform-cli/tui';

/**
 * The platform TUI menu entry that hands the terminal to the 1.3 MemoriaHub TUI.
 * Order 35 sits between the platform's `status` (30) and `node` (40) entries.
 * The component loads lazily so a headless command never imports ink.
 */
export const LEGACY_TUI_SCREEN: TuiScreenRegistration = {
  route: 'memoriahub',
  order: 35,
  label: 'MemoriaHub menu',
  load: async () => (await import('./legacy-tui.js')).LegacyTuiBridge,
};
