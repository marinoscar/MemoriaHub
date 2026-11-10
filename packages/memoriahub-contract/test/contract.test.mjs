// Contract tests for @marinoscar/memoriahub-contract: every schema parses a
// fixture shaped like the API's wire data (invented values only) and keeps the
// strictness the API has; every entry point loads through both module systems.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const slices = Object.keys(JSON.parse(readFileSync(join(here, '..', '..', 'memoriahub-slices.json'), 'utf8'))['memoriahub-contract']);

const UUID = '00000000-0000-4000-8000-000000000001';

test('every entry point loads through require and import and exports something', async () => {
  for (const slice of ['', ...slices]) {
    const specifier = slice === '' ? '@marinoscar/memoriahub-contract' : `@marinoscar/memoriahub-contract/${slice}`;
    assert.ok(Object.keys(require(specifier)).length > 0, `require ${specifier}`);
    assert.ok(Object.keys(await import(specifier)).length > 0, `import ${specifier}`);
  }
});

test('the root re-exports a schema of every slice', async () => {
  const root = await import('@marinoscar/memoriahub-contract');
  for (const name of ['burstQuerySchema', 'duplicateQuerySchema', 'mediaQuerySchema', 'workflowDefinitionSchema', 'memoryCardSchema', 'checkinSchema', 'searchQuerySchema', 'mergePeopleSchema']) {
    assert.equal(typeof root[name]?.parse, 'function', name);
  }
});

test('burst query: defaults apply and bounds are enforced', async () => {
  const { burstQuerySchema } = await import('@marinoscar/memoriahub-contract/burst');
  assert.deepEqual(burstQuerySchema.parse({ circleId: UUID }), {
    circleId: UUID, status: 'pending', page: 1, pageSize: 20, sortBy: 'capturedAt', sortOrder: 'asc',
  });
  assert.equal(burstQuerySchema.safeParse({ circleId: UUID, pageSize: 101 }).success, false);
  assert.equal(burstQuerySchema.safeParse({ circleId: 'nope' }).success, false);
});

test('bulk tags body needs an add or a remove', async () => {
  const { bulkTagsSchema } = await import('@marinoscar/memoriahub-contract/media');
  assert.equal(bulkTagsSchema.safeParse({ circleId: UUID, ids: [UUID] }).success, false);
  assert.equal(bulkTagsSchema.safeParse({ circleId: UUID, ids: [UUID], add: ['holiday'] }).success, true);
});

test('media create body: dates arrive as ISO strings and become Dates', async () => {
  const { createMediaSchema } = await import('@marinoscar/memoriahub-contract/media');
  const parsed = createMediaSchema.parse({
    storageObjectId: UUID, type: 'photo', source: 'cli', originalFilename: 'a.jpg', circleId: UUID, capturedAt: '2025-01-02T03:04:05.000Z',
  });
  assert.ok(parsed.capturedAt instanceof Date);
  assert.equal(createMediaSchema.safeParse({ ...parsed, capturedAt: 'yesterday', storageObjectId: UUID }).success, false);
  assert.equal(createMediaSchema.safeParse({ storageObjectId: UUID, type: 'photo', source: 'cli', originalFilename: 'a.jpg', circleId: UUID, coordSource: 'exif' }).success, false);
});

test('media-sync check-in: the fixture parses and an unknown key is rejected', async () => {
  const { checkinSchema } = await import('@marinoscar/memoriahub-contract/media-sync');
  assert.equal(checkinSchema.safeParse(fixture('checkin.json')).success, true);
  assert.equal(checkinSchema.safeParse({ ...fixture('checkin.json'), surprise: 1 }).success, false);
});

test('media-sync config: duplicate folders are refused', async () => {
  const { mediaSyncConfigSchema } = await import('@marinoscar/memoriahub-contract/media-sync');
  const config = {
    targetCircleId: UUID, folders: [{ bucketId: 'b1', name: 'Camera' }], includePhotos: true, includeVideos: true,
    network: 'wifi', requireCharging: false, paused: false, uploadExisting: 'all', retryFailedGeneration: 0, syncNowGeneration: 0,
  };
  assert.equal(mediaSyncConfigSchema.safeParse(config).success, true);
  assert.equal(mediaSyncConfigSchema.safeParse({ ...config, folders: [...config.folders, ...config.folders] }).success, false);
});

test('workflow definition: the fixture parses; a group inside a group and unknown keys are rejected', async () => {
  const { workflowDefinitionSchema, isGroupCondition } = await import('@marinoscar/memoriahub-contract/workflows');
  const definition = fixture('workflow-definition.json');
  const parsed = workflowDefinitionSchema.parse(definition);
  assert.equal(isGroupCondition(parsed.conditions[1]), true);
  assert.equal(isGroupCondition(parsed.conditions[0]), false);
  const nested = { ...definition, conditions: [{ match: 'all', conditions: [{ match: 'any', conditions: [{ field: 'a', op: 'equals' }] }] }] };
  assert.equal(workflowDefinitionSchema.safeParse(nested).success, false);
  assert.equal(workflowDefinitionSchema.safeParse({ ...definition, extra: true }).success, false);
});

test('workflow vocabulary matches the schema that uses it', async () => {
  const { WORKFLOW_RUN_STATUSES, WORKFLOW_TRIGGERS, listAdminWorkflowRunsQuerySchema, listAdminWorkflowsQuerySchema } = await import('@marinoscar/memoriahub-contract/workflows');
  for (const status of WORKFLOW_RUN_STATUSES) assert.equal(listAdminWorkflowRunsQuerySchema.safeParse({ status }).success, true, status);
  for (const trigger of WORKFLOW_TRIGGERS) assert.equal(listAdminWorkflowsQuerySchema.safeParse({ trigger }).success, true, trigger);
  assert.equal(listAdminWorkflowRunsQuerySchema.safeParse({ status: 'nope' }).success, false);
});

test('memory card: the fixture parses and a feed card needs thumbnails', async () => {
  const { memoryCardSchema, memoryFeedCardSchema, MEMORY_TYPES } = await import('@marinoscar/memoriahub-contract/memories');
  const card = fixture('memory-card.json');
  assert.equal(memoryCardSchema.safeParse(card).success, true);
  assert.equal(memoryFeedCardSchema.safeParse(card).success, false);
  assert.equal(memoryFeedCardSchema.safeParse({ ...card, itemThumbnailUrls: [] }).success, true);
  assert.equal(memoryCardSchema.safeParse({ ...card, type: 'nonsense' }).success, false);
  assert.equal(MEMORY_TYPES.length, 7);
});

test('enhancement list query accepts concrete statuses and the three aliases', async () => {
  const { listEnhancementsQuerySchema, ENHANCEMENT_STATUSES, ENHANCEMENT_STATUS_ALIASES } = await import('@marinoscar/memoriahub-contract/enhancement');
  for (const status of [...ENHANCEMENT_STATUSES, ...Object.keys(ENHANCEMENT_STATUS_ALIASES)]) {
    assert.equal(listEnhancementsQuerySchema.safeParse({ circleId: UUID, status }).success, true, status);
  }
  assert.equal(listEnhancementsQuerySchema.safeParse({ circleId: UUID, status: 'nope' }).success, false);
});

test('search: a malformed filter value is rejected with its path', async () => {
  const { searchQuerySchema } = await import('@marinoscar/memoriahub-contract/search');
  assert.equal(searchQuerySchema.safeParse({ circleId: UUID, filters: { near: { lat: 10, lng: 20, radiusKm: 5 } } }).success, true);
  const bad = searchQuerySchema.safeParse({ circleId: UUID, filters: { near: { lat: 100, lng: 20, radiusKm: 5 } } });
  assert.equal(bad.success, false);
  assert.deepEqual(bad.error.issues[0].path, ['filters', 'near']);
});

test('merge people refuses the same person twice', async () => {
  const { mergePeopleSchema } = await import('@marinoscar/memoriahub-contract/face');
  assert.equal(mergePeopleSchema.safeParse({ sourceId: UUID, targetId: UUID }).success, false);
});

test('primitives: bbox, time zones and the lenient date', async () => {
  const { bboxInput, isSupportedTimeZone, flexibleDate } = await import('@marinoscar/memoriahub-contract/primitives');
  assert.deepEqual(bboxInput.parse('-10, -5, 10, 5'), { minLng: -10, minLat: -5, maxLng: 10, maxLat: 5 });
  assert.equal(bboxInput.safeParse('1,2,3').success, false);
  assert.equal(isSupportedTimeZone('UTC'), true);
  assert.equal(isSupportedTimeZone('Asia/Kolkata'), true);
  assert.equal(isSupportedTimeZone('Mars/Olympus'), false);
  assert.equal(isSupportedTimeZone(''), false);
  assert.equal(flexibleDate.safeParse('2025-01-01').success, true);
  assert.equal(flexibleDate.safeParse('not a date').success, false);
});

test('error reasons are frozen and unique strings keyed by themselves', async () => {
  const { MEDIA_SYNC_ERROR_REASONS, SHARE_ERROR_REASONS } = await import('@marinoscar/memoriahub-contract/errors');
  for (const map of [MEDIA_SYNC_ERROR_REASONS, SHARE_ERROR_REASONS]) {
    assert.ok(Object.isFrozen(map));
    for (const [key, value] of Object.entries(map)) assert.equal(key, value);
  }
  assert.equal(MEDIA_SYNC_ERROR_REASONS.TARGET_OWNER_FORBIDDEN, 'TARGET_OWNER_FORBIDDEN');
});

test('media-sync limits keep their documented values', async () => {
  const c = await import('@marinoscar/memoriahub-contract/media-sync');
  assert.equal(c.RUNS_KEPT_PER_DEVICE, 200);
  assert.equal(c.REPORTS_KEPT_PER_DEVICE, 20);
  assert.equal(c.DIAGNOSTIC_REPORT_MAX_BYTES, 256 * 1024);
  assert.ok(c.SIGNING_SHA256_PATTERN.test(Array(32).fill('AB').join(':')));
});
