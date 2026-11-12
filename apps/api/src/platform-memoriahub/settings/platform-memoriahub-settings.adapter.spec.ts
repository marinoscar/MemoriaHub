import { PlatformMemoriahubSettingsAdapter } from './platform-memoriahub-settings.adapter';

describe('PlatformMemoriahubSettingsAdapter.peekSystem (RETRO-J10, #624)', () => {
  function build() {
    const system = {
      getSettings: jest.fn(async () => {
        throw new Error('getSettings creates the row on a fresh install: a Doctor read must not call it');
      }),
      readKnownValue: jest.fn(async () => ({ version: 7, features: { socialMediaDetection: true } })),
    };
    return { system, adapter: new PlatformMemoriahubSettingsAdapter(system as never, {} as never, {} as never) };
  }

  it('reads the stored document through the read-only path, with its version', async () => {
    const { adapter, system } = build();
    await expect(adapter.peekSystem<{ socialMediaDetection: boolean }>('features')).resolves.toEqual({
      value: { socialMediaDetection: true },
      version: 7,
    });
    expect(system.getSettings).not.toHaveBeenCalled();
  });

  it('answers undefined for a namespace the document does not carry and no declaration defaults it', async () => {
    const { adapter } = build();
    await expect(adapter.peekSystem('nope')).resolves.toEqual({ value: undefined, version: 7 });
  });
});
