import { describe, expect, it } from 'vitest';
import { formatNodeVital, nodeVitalFor } from '@marinoscar/platform-web/nodes/headless';
import {
  MEMORIAHUB_NODE_VITALS,
  registerMemoriahubNodeVitals,
} from '../../platform-extensions/nodes/memoriahubNodeVitals';

describe('memoriahubNodeVitals', () => {
  it('registers every vital the executors report, keys within the platform pattern and the 16-key cap', () => {
    registerMemoriahubNodeVitals();
    expect(MEMORIAHUB_NODE_VITALS.length).toBeLessThanOrEqual(16);
    for (const def of MEMORIAHUB_NODE_VITALS) {
      expect(def.key).toMatch(/^[a-z][a-z0-9_.]{1,47}$/);
      expect(nodeVitalFor(def.key)).toMatchObject({ label: def.label, unit: def.unit });
    }
  });

  it('words a value in its unit', () => {
    registerMemoriahubNodeVitals();
    expect(formatNodeVital(12.5, nodeVitalFor('compreface.latency_ms'))).toBe('13 ms');
    expect(formatNodeVital(3, nodeVitalFor('clip.session.recycles'))).toContain('3');
  });

  it('is idempotent', () => {
    expect(() => registerMemoriahubNodeVitals()).not.toThrow();
  });
});
