import { jobsConfiguration } from '@marinoscar/platform-api/jobs';

import {
  configuredWorkerMode,
  legacyJobsEnv,
  resetLegacyEnvWarnings,
  videoJobTimeoutMs,
} from './legacy-env';

describe('legacyJobsEnv (ENRICHMENT_* -> JOBS_*)', () => {
  let warnings: string[];
  const warn = (message: string) => warnings.push(message);

  beforeEach(() => {
    warnings = [];
    resetLegacyEnvWarnings();
  });

  it('with nothing set, keeps the old queue defaults the platform would otherwise change', () => {
    const env = legacyJobsEnv({}, warn);
    expect(env.JOBS_WORKER_CONCURRENCY).toBe('1');
    expect(env.JOBS_SYSTEM_MODE_EXTRA_TYPES).toBe('workflow_execute_batch');
    expect(warnings).toEqual([]);
  });

  it.each([
    ['ENRICHMENT_WORKER_MODE', 'system', 'JOBS_WORKER_MODE'],
    ['ENRICHMENT_WORKER_CONCURRENCY', '3', 'JOBS_WORKER_CONCURRENCY'],
    ['FACE_WORKER_CONCURRENCY', '4', 'JOBS_WORKER_CONCURRENCY'],
    ['ENRICHMENT_JOB_POLL_MS', '1000', 'JOBS_POLL_MS'],
    ['FACE_JOB_POLL_MS', '2000', 'JOBS_POLL_MS'],
    ['ENRICHMENT_JOB_TIMEOUT_MS', '123', 'JOBS_JOB_TIMEOUT_MS'],
    ['ENRICHMENT_MAX_ATTEMPTS', '5', 'JOBS_MAX_ATTEMPTS'],
    ['ENRICHMENT_RETRY_BASE_MS', '10', 'JOBS_RETRY_BASE_MS'],
    ['ENRICHMENT_RETRY_MAX_MS', '99', 'JOBS_RETRY_MAX_MS'],
    ['ENRICHMENT_RATELIMIT_BASE_MS', '11', 'JOBS_RATELIMIT_BASE_MS'],
    ['ENRICHMENT_RATELIMIT_MAX_MS', '12', 'JOBS_RATELIMIT_MAX_MS'],
    ['ENRICHMENT_RATELIMIT_MAX_HITS', '13', 'JOBS_RATELIMIT_MAX_HITS'],
    ['ENRICHMENT_REAPER_ENABLED', 'false', 'JOBS_REAPER_ENABLED'],
  ])('%s=%s is read as %s and warns once', (legacy, value, target) => {
    const env = legacyJobsEnv({ [legacy]: value }, warn);
    expect(env[target]).toBe(value);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(legacy);
    expect(warnings[0]).toContain(target);
  });

  it('the JOBS_* variable wins when both are set, and the warning says the legacy one is ignored', () => {
    const env = legacyJobsEnv({ ENRICHMENT_MAX_ATTEMPTS: '9', JOBS_MAX_ATTEMPTS: '2' }, warn);
    expect(env.JOBS_MAX_ATTEMPTS).toBe('2');
    expect(warnings[0]).toContain('ignored');
  });

  it('warns once per variable, not once per call', () => {
    legacyJobsEnv({ ENRICHMENT_MAX_ATTEMPTS: '9' }, warn);
    legacyJobsEnv({ ENRICHMENT_MAX_ATTEMPTS: '9' }, warn);
    expect(warnings).toHaveLength(1);
  });

  it('does not mutate the environment it was given', () => {
    const source = { ENRICHMENT_MAX_ATTEMPTS: '9' };
    legacyJobsEnv(source, warn);
    expect(source).toEqual({ ENRICHMENT_MAX_ATTEMPTS: '9' });
  });

  describe('worker mode', () => {
    it.each([['ENRICHMENT_WORKER_ENABLED'], ['FACE_WORKER_ENABLED']])('%s=false means off', (name) => {
      expect(legacyJobsEnv({ [name]: 'false' }, warn).JOBS_WORKER_MODE).toBe('off');
    });

    it('an explicit mode beats the on/off switches', () => {
      const env = legacyJobsEnv({ ENRICHMENT_WORKER_MODE: 'system', ENRICHMENT_WORKER_ENABLED: 'false' }, warn);
      expect(env.JOBS_WORKER_MODE).toBe('system');
    });

    it('configuredWorkerMode answers the same without warning', () => {
      expect(configuredWorkerMode({})).toBe('all');
      expect(configuredWorkerMode({ ENRICHMENT_WORKER_ENABLED: 'false' })).toBe('off');
      expect(configuredWorkerMode({ ENRICHMENT_WORKER_MODE: 'system' })).toBe('system');
      expect(configuredWorkerMode({ JOBS_WORKER_MODE: 'off', ENRICHMENT_WORKER_MODE: 'all' })).toBe('off');
    });
  });

  describe('system-mode extra types', () => {
    it('adds the operator list to the always-pinned type', () => {
      const env = legacyJobsEnv({ ENRICHMENT_SYSTEM_MODE_EXTRA_TYPES: 'geocode, metadata_extraction' }, warn);
      expect(env.JOBS_SYSTEM_MODE_EXTRA_TYPES!.split(',').sort()).toEqual(
        ['geocode', 'metadata_extraction', 'workflow_execute_batch'].sort(),
      );
    });

    it('does not repeat a pinned type the operator also named', () => {
      const env = legacyJobsEnv({ JOBS_SYSTEM_MODE_EXTRA_TYPES: 'workflow_execute_batch,geocode' }, warn);
      expect(env.JOBS_SYSTEM_MODE_EXTRA_TYPES!.split(',').filter((t) => t === 'workflow_execute_batch')).toHaveLength(1);
    });
  });

  describe('removed variables', () => {
    it.each([['ENRICHMENT_LEASE_MS'], ['ENRICHMENT_STUCK_MINUTES']])('%s warns that it is no longer read', (name) => {
      legacyJobsEnv({ [name]: '60' }, warn);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('no longer read');
    });
  });

  describe('videoJobTimeoutMs', () => {
    it('is 20 minutes by default', () => {
      expect(videoJobTimeoutMs({})).toBe(1_200_000);
    });

    it('honours ENRICHMENT_VIDEO_JOB_TIMEOUT_MS, 0 included (no ceiling)', () => {
      expect(videoJobTimeoutMs({ ENRICHMENT_VIDEO_JOB_TIMEOUT_MS: '1800000' })).toBe(1_800_000);
      expect(videoJobTimeoutMs({ ENRICHMENT_VIDEO_JOB_TIMEOUT_MS: '0' })).toBe(0);
    });

    it('falls back to the default for garbage or a negative value', () => {
      expect(videoJobTimeoutMs({ ENRICHMENT_VIDEO_JOB_TIMEOUT_MS: 'soon' })).toBe(1_200_000);
      expect(videoJobTimeoutMs({ ENRICHMENT_VIDEO_JOB_TIMEOUT_MS: '-5' })).toBe(1_200_000);
    });
  });

  it('the result feeds the platform configuration (what configuration.ts does)', () => {
    const { jobs } = jobsConfiguration(
      legacyJobsEnv(
        {
          ENRICHMENT_WORKER_MODE: 'system',
          ENRICHMENT_MAX_ATTEMPTS: '5',
          ENRICHMENT_RATELIMIT_MAX_HITS: '7',
          ENRICHMENT_REAPER_ENABLED: 'false',
        },
        warn,
      ),
    );
    expect(jobs).toMatchObject({
      workerMode: 'system',
      maxAttempts: 5,
      rateLimitMaxHits: 7,
      reaperEnabled: false,
      workerConcurrency: 1,
      systemModeExtraTypes: ['workflow_execute_batch'],
    });
  });
});
