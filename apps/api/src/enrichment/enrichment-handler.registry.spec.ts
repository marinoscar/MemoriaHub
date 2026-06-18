/**
 * Unit tests for EnrichmentHandlerRegistry.
 *
 * Tests: handler registration via register(), get() lookup, types()
 * enumeration, empty registry, unknown-type lookup, duplicate-type
 * overwrite (last registered wins, warn emitted).
 *
 * The registry has no constructor arguments so it is instantiated directly
 * without the NestJS testing module — keeping tests fast.
 */

import { EnrichmentHandlerRegistry } from './enrichment-handler.registry';
import { EnrichmentHandler } from './enrichment-handler.interface';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandler(type: string): EnrichmentHandler {
  return {
    type,
    process: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnrichmentHandlerRegistry', () => {
  let registry: EnrichmentHandlerRegistry;

  beforeEach(() => {
    registry = new EnrichmentHandlerRegistry();
  });

  // -------------------------------------------------------------------------
  // Empty registry
  // -------------------------------------------------------------------------

  describe('empty registry (no registrations)', () => {
    it('types() returns an empty array when nothing has been registered', () => {
      expect(registry.types()).toEqual([]);
    });

    it('get() returns undefined for any type when no handlers are registered', () => {
      expect(registry.get('face_detection')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Single handler
  // -------------------------------------------------------------------------

  describe('single handler registration', () => {
    it('get() returns the handler after register() is called', () => {
      const handler = makeHandler('face_detection');

      registry.register(handler);

      expect(registry.get('face_detection')).toBe(handler);
    });

    it('types() returns the single registered type', () => {
      const handler = makeHandler('face_detection');

      registry.register(handler);

      expect(registry.types()).toEqual(['face_detection']);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple handlers
  // -------------------------------------------------------------------------

  describe('multiple handler registrations', () => {
    it('get() returns the correct handler for each type', () => {
      const faceHandler = makeHandler('face_detection');
      const ocrHandler = makeHandler('ocr');
      const tagHandler = makeHandler('auto_tag');

      registry.register(faceHandler);
      registry.register(ocrHandler);
      registry.register(tagHandler);

      expect(registry.get('face_detection')).toBe(faceHandler);
      expect(registry.get('ocr')).toBe(ocrHandler);
      expect(registry.get('auto_tag')).toBe(tagHandler);
    });

    it('types() lists all registered type strings', () => {
      const faceHandler = makeHandler('face_detection');
      const ocrHandler = makeHandler('ocr');

      registry.register(faceHandler);
      registry.register(ocrHandler);

      expect(registry.types()).toHaveLength(2);
      expect(registry.types()).toContain('face_detection');
      expect(registry.types()).toContain('ocr');
    });
  });

  // -------------------------------------------------------------------------
  // Unknown type
  // -------------------------------------------------------------------------

  describe('get() for unknown type', () => {
    it('returns undefined when the type has not been registered', () => {
      const handler = makeHandler('face_detection');
      registry.register(handler);

      expect(registry.get('nonexistent_type')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate type — last one wins, warn emitted
  // -------------------------------------------------------------------------

  describe('duplicate type registration', () => {
    it('last registered handler overwrites the first for the same type', () => {
      const first = makeHandler('face_detection');
      const second = makeHandler('face_detection');

      registry.register(first);
      registry.register(second);

      expect(registry.get('face_detection')).toBe(second);
    });

    it('types() does not duplicate keys when a type is overwritten', () => {
      const first = makeHandler('face_detection');
      const second = makeHandler('face_detection');

      registry.register(first);
      registry.register(second);

      const types = registry.types();
      expect(types.filter((t) => t === 'face_detection')).toHaveLength(1);
    });

    it('emits a logger warn when a duplicate type is registered', () => {
      const first = makeHandler('face_detection');
      const second = makeHandler('face_detection');

      // Spy on the private logger through the prototype chain
      const warnSpy = jest
        .spyOn((registry as any).logger, 'warn')
        .mockImplementation(() => undefined);

      registry.register(first);
      registry.register(second); // should trigger warn

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('face_detection'),
      );
    });
  });
});
