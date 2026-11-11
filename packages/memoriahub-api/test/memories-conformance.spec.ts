// =============================================================================
// describeMemoriesSliceConformance against the memories slice over the in-memory fakes (RETRO-J8, #619)
// =============================================================================

import 'reflect-metadata';

import { Test } from '@nestjs/testing';

import { MemoriahubPortsModule } from '../src/core/index.js';
import type { MemoriahubJobHandler } from '../src/ports/index.js';
import { MEMORIES_ALBUMS, MemoriesModule } from '../src/memories/index.js';
import { describeMemoriesSliceConformance } from '../src/memories/testing/index.js';
import { createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

async function memoriesOverFakes() {
  const fakes = createFakeMemoriahubPorts();
  const handlers: MemoriahubJobHandler[] = [];
  const register = fakes.jobs.registerHandler.bind(fakes.jobs);
  fakes.jobs.registerHandler = (handler) => {
    handlers.push(handler);
    register(handler);
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      MemoriahubPortsModule.forRoot({ ports: fakeMemoriahubBindings(fakes) }),
      MemoriesModule.forRoot({
        digest: { signingKey: () => Buffer.alloc(32, 1) },
        providers: [{ provide: MEMORIES_ALBUMS, useValue: {} }],
      }),
    ],
  }).compile();
  await moduleRef.init();
  return { handlers };
}

describeMemoriesSliceConformance(
  { describe, it, expect } as never,
  { name: 'in-memory fakes', create: memoriesOverFakes },
);
