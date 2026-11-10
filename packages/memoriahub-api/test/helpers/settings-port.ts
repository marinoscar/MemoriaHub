// =============================================================================
// A settings port answering from a plain object, for the slice specs
// =============================================================================
//
// The specs of the code that moved out of the web app seed "the whole settings document"
// (`{ features: {...}, locationGrouping: {...} }`); the slices read one namespace at a time through
// `MEMORIAHUB_SETTINGS.readSystem(name)`. This adapter answers each namespace from the document.
// =============================================================================

/**
 * Builds a settings port over a settings document (a function is re-read on every call, so a spec can
 * change the document between calls).
 *
 * @param source - the document, or a function that returns it.
 */
export function settingsPortFrom(source: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>)) {
  return {
    readSystem: jest.fn(async (name: string) => {
      const doc = typeof source === 'function' ? await source() : source;
      return { value: doc[name], version: 1 };
    }),
    readUser: jest.fn(async () => ({})),
    registerNamespace: jest.fn(),
    patchSystem: jest.fn(),
    patchUser: jest.fn(),
    readUserTimeZone: jest.fn(async () => 'UTC'),
  };
}
