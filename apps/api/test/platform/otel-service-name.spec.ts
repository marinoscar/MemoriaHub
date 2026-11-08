import { resolveServiceName } from '../../src/common/otel/telemetry-identity';

describe('telemetry service name', () => {
  const original = process.env.OTEL_SERVICE_NAME;
  afterEach(() => {
    if (original === undefined) delete process.env.OTEL_SERVICE_NAME;
    else process.env.OTEL_SERVICE_NAME = original;
  });

  it('defaults to memoriahub-api', () => {
    delete process.env.OTEL_SERVICE_NAME;
    expect(resolveServiceName()).toBe('memoriahub-api');
  });

  it('honours OTEL_SERVICE_NAME', () => {
    process.env.OTEL_SERVICE_NAME = 'custom-api';
    expect(resolveServiceName()).toBe('custom-api');
  });
});
