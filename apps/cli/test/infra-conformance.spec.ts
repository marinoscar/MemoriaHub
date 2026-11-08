import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeFilesForMode } from '@marinoscar/platform-infra';
import { runInfraConformance } from '@marinoscar/platform-infra/testing';

// =============================================================================
// The generated infra and this app's overlays hold together  (issue #566)
// =============================================================================
//
// `infra/` is rendered by `npm run platform:infra:sync` from
// `@marinoscar/platform-infra`. MemoriaHub's differences live only in app-owned
// files: infra/compose/app.*.compose.yml, infra/compose/app.env.example,
// infra/nginx/app.d/** and infra/otel/app-collector.yaml.
//
// `runInfraConformance` proves that `sync --check` is clean, that every mode
// renders with the overlays (`docker compose config`) and that `nginx -t`
// accepts app.d/ with both CSP files. Docker and nginx are tools: where one is
// missing the case passes under a name that says so, and CI, which has Docker,
// runs the checks.
// =============================================================================

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const COMPOSE_DIR = join(REPO_ROOT, 'infra', 'compose');
const NGINX_DIR = join(REPO_ROOT, 'infra', 'nginx');

// The platform's test-API shape, bound to Jest's globals (its `it` and `expect`
// types are wider than the shape the platform declares).
const testApi = {
  describe: (name: string, body: () => void) => describe(name, body),
  it: (name: string, body: () => unknown) =>
    it(name, async () => {
      await body();
    }),
  expect: (actual: unknown) => expect(actual),
};

runInfraConformance({
  appRoot: REPO_ROOT,
  testApi,
  modes: ['dev', 'devdb', 'prod', 'vps', 'worker', 'test'],
  env: {
    // vps.compose.yml and worker.compose.yml refuse to render without these.
    STACK_AGENT_TOKEN: 'a'.repeat(64),
    DEPLOY_ROOT: '/opt/infra/apps/memoriahub',
    MEMORIAHUB_SERVER_URL: 'https://app.example.com',
    MEMORIAHUB_TOKEN: 'nod_conformance',
  },
});

const overlays = readdirSync(COMPOSE_DIR).filter((name) => name.startsWith('app.'));

describe('the overlays of this app', () => {
  it('apply to each mode as intended', () => {
    const appFiles = (mode: Parameters<typeof composeFilesForMode>[0], telemetry = false) =>
      composeFilesForMode(mode, { telemetry, overlays }).filter((file) => file.startsWith('app.'));

    expect(appFiles('dev')).toEqual(['app.compreface.compose.yml', 'app.models-volume.compose.yml']);
    expect(appFiles('devdb')).toEqual(['app.compreface.compose.yml', 'app.devdb.pgvector.compose.yml', 'app.models-volume.compose.yml']);
    expect(appFiles('prod')).toEqual([
      'app.compreface.compose.yml',
      'app.models-volume.compose.yml',
      'app.prod.memory-limits.compose.yml',
      'app.prod.web-listen.compose.yml',
    ]);
    expect(appFiles('vps')).toEqual([
      'app.compreface.compose.yml',
      'app.models-volume.compose.yml',
      'app.prod.memory-limits.compose.yml',
      'app.prod.web-listen.compose.yml',
      'app.vps.no-stack-agent.compose.yml',
    ]);
    expect(appFiles('test')).toEqual(['app.test.pgvector.compose.yml']);
    expect(appFiles('worker')).toEqual([
      'app.worker.build.compose.yml',
      'app.worker.compreface.compose.yml',
      'app.worker.memoriahub.compose.yml',
    ]);
  });

  it('carry no secret: an overlay holds sizes and switches, never a value that is a credential', () => {
    for (const name of overlays) {
      const body = readFileSync(join(COMPOSE_DIR, name), 'utf8');
      // Only lines that are not comments: the comments name the variables.
      expect(body).not.toMatch(/^[^#\n]*(SECRET|PASSWORD|PRIVATE_KEY)[A-Z_]*[ \t]*[:=][ \t]*[^\s$]/m);
    }
  });

  it('keep the MemoriaHub nginx locations next to the generated ones', () => {
    const nginx = readFileSync(join(NGINX_DIR, 'nginx.conf'), 'utf8');
    // The generated server block includes the app's include points.
    expect(nginx).toContain('include /etc/nginx/app.d/locations/*.conf;');
    expect(nginx).toContain('include /etc/nginx/app.d/server/*.conf;');

    const android = readFileSync(join(NGINX_DIR, 'app.d', 'locations', 'android-app.conf'), 'utf8');
    expect(android).toContain('include /etc/nginx/platform/android-app.conf;');
    const generatedAndroid = readFileSync(join(NGINX_DIR, 'platform', 'android-app.conf'), 'utf8');
    expect(generatedAndroid).toContain('location = /.well-known/assetlinks.json');
    expect(generatedAndroid).toContain('client_max_body_size 160m;');

    const uploads = readFileSync(join(NGINX_DIR, 'app.d', 'locations', 'app-uploads.conf'), 'utf8');
    expect(uploads).toContain('location ~ ^/api/storage/objects/[^/]+/upload/parts/');
    expect(uploads).toMatch(/client_max_body_size 64m;/);

    expect(readFileSync(join(NGINX_DIR, 'app.d', 'server', 'body-size.conf'), 'utf8')).toMatch(/client_max_body_size 10g;/);
  });

  it('keep the geolocation permission the location picker needs', () => {
    const policy = readFileSync(join(NGINX_DIR, 'app.d', 'permissions-policy.conf'), 'utf8');
    expect(policy).toContain('geolocation=(self)');
  });

  it('retire the hand-written files the generated ones replace', () => {
    for (const gone of [
      join(COMPOSE_DIR, 'otel.compose.yml'),
      join(REPO_ROOT, 'infra', 'otel', 'uptrace.yml'),
    ]) {
      expect(existsSync(gone)).toBe(false);
    }
  });

  // `infra/nginx/nginx.prod.conf` and the root `docker-compose.worker*.yml`
  // stay until RETRO-F3: `infra/deploy/install.sh` mounts the nginx file into
  // existing production stacks, and fleet operators run the root worker bundle.
});
