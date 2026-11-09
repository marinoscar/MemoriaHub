// The WEBHOOKS_SYSTEM_PRISMA binding (RETRO-H4, #603; RETRO-D1): both halves of the port open a
// bypass transaction on the system client (PrismaSystemService), naming the caller's reason.

import { webhooksSystemPrisma } from '../../src/platform/webhooks/webhooks-host.module';

describe('webhooksSystemPrisma', () => {
  const system = {
    asSystem: jest.fn(() => ({ scoped: true })),
    runAsSystem: jest.fn(async (_reason: string, fn: (tx: unknown) => unknown) => fn({ tx: true })),
  };

  it('asSystem is PrismaSystemService.asSystem', () => {
    const port = webhooksSystemPrisma(system as never);
    expect(port.asSystem('webhooks')).toEqual({ scoped: true });
    expect(system.asSystem).toHaveBeenCalledWith('webhooks');
  });

  it('runAsSystem is PrismaSystemService.runAsSystem, passing the options through', async () => {
    const port = webhooksSystemPrisma(system as never);
    const result = await port.runAsSystem('retention', async (tx) => tx, { timeout: 5000 });
    expect(result).toEqual({ tx: true });
    expect(system.runAsSystem).toHaveBeenCalledWith('retention', expect.any(Function), { timeout: 5000 });
  });
});
