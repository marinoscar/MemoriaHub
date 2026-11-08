// The WEBHOOKS_SYSTEM_PRISMA binding (RETRO-H4, #603): both halves of the port open a
// bypass transaction on the app's client, naming the caller's reason.

jest.mock('@marinoscar/platform-api/core', () => {
  const actual = jest.requireActual('@marinoscar/platform-api/core');
  return {
    ...actual,
    forSystem: jest.fn(() => ({ scoped: true })),
    runAsSystem: jest.fn(async (_client: unknown, _reason: string, fn: (tx: unknown) => unknown) => fn({ tx: true })),
  };
});

import { forSystem, runAsSystem } from '@marinoscar/platform-api/core';

import { webhooksSystemPrisma } from '../../src/platform/webhooks/webhooks-host.module';

describe('webhooksSystemPrisma', () => {
  const prisma = { client: true };

  it('asSystem is the platform forSystem over the app client', () => {
    const port = webhooksSystemPrisma(prisma as never);
    expect(port.asSystem('webhooks')).toEqual({ scoped: true });
    expect(forSystem).toHaveBeenCalledWith(prisma, 'webhooks');
  });

  it('runAsSystem is the platform runAsSystem, passing the options through', async () => {
    const port = webhooksSystemPrisma(prisma as never);
    const result = await port.runAsSystem('retention', async (tx) => tx, { timeout: 5000 });
    expect(result).toEqual({ tx: true });
    expect(runAsSystem).toHaveBeenCalledWith(prisma, 'retention', expect.any(Function), { timeout: 5000 });
  });
});
