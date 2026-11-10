import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests, runPlatformConformance } from '@marinoscar/platform-cli/testing';

import { APP_CLI_OPTIONS } from '../src/app.js';
import { backupDashboardReducer } from '../src/tui/backup-dashboard-source.js';
import { jobsDashboardReducer } from '../src/tui/jobs-dashboard-source.js';

// The platform CLI's conformance suites over MemoriaHub's composition (#577):
// env template hygiene, executor credential hygiene, deploy registrations.
const ENV_EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'infra', 'compose', '.env.example');

resetCliForTests();
createCli(APP_CLI_OPTIONS);

runPlatformConformance({
  testApi: {
    describe: (name, body) => describe(name, body),
    it: (name, body) => it(name, async () => { await body(); }),
    expect: (actual) => expect(actual) as never,
  },
  suites: {
    cli: {
      envFragments: [
        {
          name: 'infra/compose/.env.example',
          text: readFileSync(ENV_EXAMPLE, 'utf8'),
          allowCommented: ['CORS_ORIGIN', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_CALLBACK_URL', 'TEST_AUTH_ENABLED', 'MAINTENANCE_MODE', 'OTEL_DEBUG', 'JOBS_SYSTEM_MODE_EXTRA_TYPES'],
        },
      ],
    },
    deployRegistrations: {},
    // The platform TUI framework's checks over MemoriaHub's menu, screens and dashboards (RETRO-F4, #582).
    tui: {
      // Each dashboard's reducer folds its events into a frozen initial state without changing it.
      dashboards: [
        {
          id: 'backup',
          reducer: backupDashboardReducer(),
          events: [
            { ev: 'backup:run-started', payload: { runId: 'r1', kind: 'incremental', trigger: 'manual' }, atMs: 1 },
          ],
          snapshot: { configured: true, running: null, lastRun: null, checkpoint: null, counters: null, rate: null },
        },
        {
          id: 'jobs',
          reducer: jobsDashboardReducer(() => 1),
          events: [],
        },
      ],
    },
  },
});
