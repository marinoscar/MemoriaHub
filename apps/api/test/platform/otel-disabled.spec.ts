describe('OpenTelemetry disabled', () => {
  const original = process.env.OTEL_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.OTEL_ENABLED;
    else process.env.OTEL_ENABLED = original;
    jest.resetModules();
  });

  it('instrumentation exports a null sdk when OTEL_ENABLED is unset', () => {
    delete process.env.OTEL_ENABLED;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sdk } = require('../../src/instrumentation');
    expect(sdk).toBeNull();
  });

  it('the platform @Trace passes results and errors through untouched', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Trace } = require('@marinoscar/platform-api/otel-core');
    class Sample {
      @Trace('sample.ok')
      async ok(): Promise<number> {
        return 7;
      }
      @Trace('sample.fail')
      async fail(): Promise<void> {
        throw new Error('boom');
      }
    }
    const s = new Sample();
    await expect(s.ok()).resolves.toBe(7);
    await expect(s.fail()).rejects.toThrow('boom');
  });
});
