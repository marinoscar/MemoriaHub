import { TELEMETRY_SETTINGS_DEFAULTS } from '@marinoscar/platform-api/telemetry';

import { planTelemetrySettingsCarryOver } from './telemetry-settings.migration';

describe('planTelemetrySettingsCarryOver', () => {
  it('turns telemetry on for a deployment that exported (OTEL_ENABLED=true, nothing stored)', () => {
    const stored = { ui: { theme: 'dark' } };
    const { change, next } = planTelemetrySettingsCarryOver(stored, true);

    expect(change.action).toBe('write');
    expect(next).toEqual({ ui: { theme: 'dark' }, telemetry: { ...TELEMETRY_SETTINGS_DEFAULTS, enabled: true } });
    expect(stored).toEqual({ ui: { theme: 'dark' } });
  });

  it('leaves a stored telemetry value alone, on or off (idempotent)', () => {
    const stored = { telemetry: { ...TELEMETRY_SETTINGS_DEFAULTS, enabled: false } };
    const { change, next } = planTelemetrySettingsCarryOver(stored, true);

    expect(change.action).toBe('keep');
    expect(next).toEqual(stored);
  });

  it('writes nothing when the deployment never exported', () => {
    const { change, next } = planTelemetrySettingsCarryOver({}, false);

    expect(change.action).toBe('skip');
    expect(next).toEqual({});
  });

  it('a second run after a write keeps', () => {
    const first = planTelemetrySettingsCarryOver({}, true).next;
    expect(planTelemetrySettingsCarryOver(first, true).change.action).toBe('keep');
  });
});
