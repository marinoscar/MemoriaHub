import { RETIRED_JOB_HISTORY_PURGE_TYPE, RetiredJobTypeHandler } from './retired-job-types';

describe('RetiredJobTypeHandler', () => {
  it('keeps the permanent job_history_purge string dispatching', () => {
    const register = jest.fn();
    const handler = new RetiredJobTypeHandler({ register } as never);

    handler.onModuleInit();

    expect(RETIRED_JOB_HISTORY_PURGE_TYPE).toBe('job_history_purge');
    expect(register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('job_history_purge');
  });

  it('settles a row of the retired type without doing anything', async () => {
    const handler = new RetiredJobTypeHandler({ register: jest.fn() } as never);
    await expect(handler.process({ id: 'job-1' } as never)).resolves.toBeUndefined();
  });

  it('is server-only: no node pair', () => {
    const handler = new RetiredJobTypeHandler({ register: jest.fn() } as never) as unknown as Record<string, unknown>;
    expect(handler['nodeResultSchema']).toBeUndefined();
    expect(handler['persistNodeResult']).toBeUndefined();
  });
});
