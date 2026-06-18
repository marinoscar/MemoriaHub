/**
 * Unit tests for EnrichmentHandlerRegistry.
 *
 * Tests: handler registration, get() lookup, types() enumeration,
 * single vs multi-handler injection, null (no handlers), duplicate
 * type overwrite.
 *
 * The registry constructor is simple enough to be instantiated directly
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
  // -------------------------------------------------------------------------
  // Single handler
  // -------------------------------------------------------------------------

  describe('single handler (non-array)', () => {
    it('registers the handler when a single (non-array) handler is provided', () => {
      const handler = makeHandler('face_detection');

      // Arrange: pass a single handler (not wrapped in an array) — mirrors
      // what the NestJS injector does when only one multi-provider is registered.
      const registry = new EnrichmentHandlerRegistry(handler);

      // Act / Assert
      expect(registry.get('face_detection')).toBe(handler);
    });

    it('types() returns the single registered type', () => {
      const handler = makeHandler('face_detection');

      const registry = new EnrichmentHandlerRegistry(handler);

      expect(registry.types()).toEqual(['face_detection']);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple handlers
  // -------------------------------------------------------------------------

  describe('multiple handlers (array)', () => {
    it('registers all handlers from an array', () => {
      const faceHandler = makeHandler('face_detection');
      const ocrHandler = makeHandler('ocr');

      const registry = new EnrichmentHandlerRegistry([faceHandler, ocrHandler]);

      expect(registry.get('face_detection')).toBe(faceHandler);
      expect(registry.get('ocr')).toBe(ocrHandler);
    });

    it('types() returns all registered type strings', () => {
      const faceHandler = makeHandler('face_detection');
      const ocrHandler = makeHandler('ocr');

      const registry = new EnrichmentHandlerRegistry([faceHandler, ocrHandler]);

      expect(registry.types()).toHaveLength(2);
      expect(registry.types()).toContain('face_detection');
      expect(registry.types()).toContain('ocr');
    });

    it('get() returns the correct handler for each type when multiple are registered', () => {
      const faceHandler = makeHandler('face_detection');
      const ocrHandler = makeHandler('ocr');
      const tagHandler = makeHandler('auto_tag');

      const registry = new EnrichmentHandlerRegistry([faceHandler, ocrHandler, tagHandler]);

      expect(registry.get('face_detection')).toBe(faceHandler);
      expect(registry.get('ocr')).toBe(ocrHandler);
      expect(registry.get('auto_tag')).toBe(tagHandler);
    });
  });

  // -------------------------------------------------------------------------
  // Null / empty (Optional injection returns null)
  // -------------------------------------------------------------------------

  describe('null handlers (@Optional injection)', () => {
    it('starts empty when null is provided', () => {
      const registry = new EnrichmentHandlerRegistry(null);

      expect(registry.types()).toEqual([]);
    });

    it('get() returns undefined for any type when no handlers are registered', () => {
      const registry = new EnrichmentHandlerRegistry(null);

      expect(registry.get('face_detection')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Unknown type
  // -------------------------------------------------------------------------

  describe('get() for unknown type', () => {
    it('returns undefined when the type has not been registered', () => {
      const handler = makeHandler('face_detection');
      const registry = new EnrichmentHandlerRegistry([handler]);

      expect(registry.get('nonexistent_type')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate type — last one wins
  // -------------------------------------------------------------------------

  describe('duplicate type registration', () => {
    it('overwrites the first handler when two handlers share the same type', () => {
      const first = makeHandler('face_detection');
      const second = makeHandler('face_detection');

      const registry = new EnrichmentHandlerRegistry([first, second]);

      // Arrange: the second handler should have overwritten the first
      expect(registry.get('face_detection')).toBe(second);
    });

    it('types() does not duplicate keys when a type is overwritten', () => {
      const first = makeHandler('face_detection');
      const second = makeHandler('face_detection');

      const registry = new EnrichmentHandlerRegistry([first, second]);

      const types = registry.types();
      expect(types.filter((t) => t === 'face_detection')).toHaveLength(1);
    });
  });
});
