/**
 * The upload enrichment fan-out (RETRO-J5, #613): the registry's ordering and the
 * service that walks it. Host-free.
 */
import { createFakeMemoriahubPorts } from '../../testing/index.js';
import { UploadEnrichmentRegistry, type UploadEnrichmentGate, type UploadEnrichmentItem } from './upload-enrichment.registry.js';
import { UploadEnrichmentService } from './upload-enrichment.service.js';

const photo: UploadEnrichmentItem = { id: 'm1', type: 'photo', circleId: 'c1', deletedAt: null };
const video: UploadEnrichmentItem = { id: 'm2', type: 'video', circleId: 'c1', deletedAt: null };

function gate(overrides: Partial<UploadEnrichmentGate> & { log: string[]; name: string }): UploadEnrichmentGate {
  const { log, name, ...rest } = overrides;
  return {
    mediaTypes: ['photo'],
    skipReason: () => null,
    enqueue: async () => {
      log.push(name);
      return `job=${name}`;
    },
    ...rest,
  };
}

describe('UploadEnrichmentRegistry', () => {
  it('lists the registrations of a media type in ascending order, ties in registration order', () => {
    const registry = new UploadEnrichmentRegistry();
    const log: string[] = [];
    registry.register('late', gate({ log, name: 'late', order: 600 }));
    registry.register('burst', gate({ log, name: 'burst', order: 400 }));
    registry.register('unordered-a', gate({ log, name: 'a' }));
    registry.register('unordered-b', gate({ log, name: 'b' }));
    registry.register('video-only', gate({ log, name: 'v', mediaTypes: ['video'], order: 1 }));

    expect(registry.forMediaType('photo').map((e) => e.type)).toEqual(['burst', 'late', 'unordered-a', 'unordered-b']);
    expect(registry.forMediaType('video').map((e) => e.type)).toEqual(['video-only']);
    expect(registry.forMediaType('audio')).toEqual([]);
  });

  it('replaces a registration of the same type in place', () => {
    const registry = new UploadEnrichmentRegistry();
    const log: string[] = [];
    registry.register('x', gate({ log, name: 'first' }));
    registry.register('x', gate({ log, name: 'second' }));

    expect(registry.types()).toEqual(['x']);
  });
});

describe('UploadEnrichmentService', () => {
  function make() {
    const fakes = createFakeMemoriahubPorts();
    const registry = new UploadEnrichmentRegistry();
    const service = new UploadEnrichmentService(registry, fakes.settings);
    return { registry, service };
  }

  it('enqueues in order, skips with a reason and runs the fallback of a skipped job', async () => {
    const { registry, service } = make();
    const log: string[] = [];
    registry.register('tagging', gate({ log, name: 'tagging', order: 100 }));
    registry.register('face', gate({ log, name: 'face', order: 200, skipReason: () => 'feature disabled' }));
    registry.register(
      'social',
      gate({
        log,
        name: 'social',
        mediaTypes: ['video'],
        order: 300,
        skipReason: () => 'feature disabled',
        onSkipped: async (_item, _ctx, reason) => {
          log.push(`fallback:${reason}`);
        },
      }),
    );
    registry.register('burst', gate({ log, name: 'burst', order: 400 }));

    await service.enqueueUploadEnrichment(photo);
    await service.enqueueUploadEnrichment(video);

    expect(log).toEqual(['tagging', 'burst', 'fallback:feature disabled']);
  });

  it('skips a trashed item without consulting any gate', async () => {
    const { registry, service } = make();
    const skipReason = jest.fn(() => null);
    registry.register('tagging', gate({ log: [], name: 'tagging', skipReason }));

    await service.enqueueUploadEnrichment({ ...photo, deletedAt: new Date() });

    expect(skipReason).not.toHaveBeenCalled();
  });

  it('never rethrows: a failing enqueue stops the fan-out of that item and nothing else', async () => {
    const { registry, service } = make();
    const log: string[] = [];
    registry.register('a', gate({ log, name: 'a', order: 1 }));
    registry.register('b', gate({ log, name: 'b', order: 2, enqueue: async () => { throw new Error('queue down'); } }));
    registry.register('c', gate({ log, name: 'c', order: 3 }));

    await expect(service.enqueueUploadEnrichment(photo)).resolves.toBeUndefined();

    expect(log).toEqual(['a']);
  });

  it('gives each gate the settings port', async () => {
    const { registry, service } = make();
    let seen: unknown;
    registry.register('a', gate({ log: [], name: 'a', skipReason: (_item, ctx) => { seen = ctx.settings; return null; } }));

    await service.enqueueUploadEnrichment(photo);

    expect(seen).toBeDefined();
  });

  it('reads a settings namespace once per upload however many gates read it', async () => {
    const fakes = createFakeMemoriahubPorts();
    const read = jest.spyOn(fakes.settings, 'readSystem');
    const registry = new UploadEnrichmentRegistry();
    const service = new UploadEnrichmentService(registry, fakes.settings);
    for (const name of ['a', 'b', 'c']) {
      registry.register(name, gate({ log: [], name, skipReason: async (_item, ctx) => { await ctx.settings.readSystem('features'); return null; } }));
    }

    await service.enqueueUploadEnrichment(photo);

    expect(read).toHaveBeenCalledTimes(1);
  });
});
