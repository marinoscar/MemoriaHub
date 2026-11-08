// PLATFORM-ADOPTION-SHIM(RETRO-F4): removed with the bridge in legacy-tui.tsx.

// A one-bit mailbox between the platform TUI screen (legacy-tui.tsx) and `runApp`:
// two ink applications cannot share a terminal, so the screen records that the
// user chose "MemoriaHub menu", the platform TUI unmounts, and `runApp` then
// launches the 1.3 TUI. Kept out of the .tsx file so that reading the flag never
// loads ink.

let requested = false;

/** Called by the bridge screen when the user picks "MemoriaHub menu". */
export function requestLegacyTui(): void {
  requested = true;
}

/** True once {@link requestLegacyTui} was called. */
export function legacyTuiRequested(): boolean {
  return requested;
}

/** Clears the request; `runApp` calls it as it launches the legacy TUI. */
export function clearLegacyTuiRequest(): void {
  requested = false;
}
