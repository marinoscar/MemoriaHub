/**
 * The platform's `user-data` and `org-data` sources as MemoriaHub registers them (RETRO-H2,
 * #596; PLATFORM-ADOPTION-SHIM(#596)): the same ids, permissions and writers, but no
 * storage object key, bucket, upload id or processing metadata, and no avatar object key,
 * in any byte of any format. Run over the platform's sentinel client, which fills EVERY
 * column of every registered model and ignores `select`.
 */
import { Prisma } from '@prisma/client';
import {
  ORG_DATA_EXPORT_SOURCE,
  USER_DATA_EXPORT_SOURCE,
  exportSourceRegistry,
  writersFor,
  type ExportContext,
} from '@marinoscar/platform-api/exports';
import {
  collectExportOutput,
  exportFileText,
  exportSentinel,
  sentinelExportDb,
} from '@marinoscar/platform-api/exports/testing';

import '../../src/app-registrations/ownership-manifest';
import '../../src/platform/exports/exports.config';
import {
  MEMORIAHUB_ORG_DATA_EXPORT_SOURCE,
  MEMORIAHUB_PLATFORM_DATASET_REDACTIONS,
  MEMORIAHUB_USER_DATA_EXPORT_SOURCE,
} from '../../src/platform/exports/memoriahub-platform-sources';

const SUBJECT = '00000000-0000-4000-8000-0000000000aa';
const FORBIDDEN = [
  ...MEMORIAHUB_PLATFORM_DATASET_REDACTIONS.storage_object!.map((field) => exportSentinel('StorageObject', field)),
  exportSentinel('UserProfile', 'avatarStorageKey'),
];

function ctx(scope: 'user' | 'org'): ExportContext {
  return {
    exportId: 'export-1',
    scope,
    subjectId: SUBJECT,
    requestedById: SUBJECT,
    db: sentinelExportDb(Prisma.dmmf.datamodel),
    datamodel: Prisma.dmmf.datamodel,
    pageSize: 500,
    now: new Date('2026-07-01T00:00:00.000Z'),
    timeZone: 'UTC',
  };
}

describe('user-data and org-data with MemoriaHub redaction', () => {
  it('registers them under the platform ids, first, with the platform permissions', () => {
    const ids = exportSourceRegistry.list().map((source) => source.id);
    expect(ids.slice(0, 2)).toEqual(['user-data', 'org-data']);
    expect(exportSourceRegistry.get('user-data')).toBe(MEMORIAHUB_USER_DATA_EXPORT_SOURCE);
    expect(MEMORIAHUB_USER_DATA_EXPORT_SOURCE.permission).toBe(USER_DATA_EXPORT_SOURCE.permission);
    expect(MEMORIAHUB_ORG_DATA_EXPORT_SOURCE.permission).toBe(ORG_DATA_EXPORT_SOURCE.permission);
    expect(MEMORIAHUB_ORG_DATA_EXPORT_SOURCE.crossOrgPermission).toBe(ORG_DATA_EXPORT_SOURCE.crossOrgPermission);
  });

  it.each([
    ['user-data', MEMORIAHUB_USER_DATA_EXPORT_SOURCE, 'user'],
    ['org-data', MEMORIAHUB_ORG_DATA_EXPORT_SOURCE, 'org'],
  ] as const)('%s writes no storage key, bucket, upload id, object metadata or avatar key', async (_id, source, scope) => {
    const writers = writersFor(source);
    expect(writers.map((writer) => writer.id)).toEqual(expect.arrayContaining(['json', 'csv', 'xlsx']));
    for (const writer of writers) {
      const { bytes } = await collectExportOutput(writer, source.collect(ctx(scope), {}), source.id);
      const text = exportFileText(bytes);
      // The dataset is still there: the files list keeps its name, size and type.
      if (scope === 'user') expect(text).toContain(exportSentinel('StorageObject', 'name'));
      for (const sentinel of FORBIDDEN) expect(text).not.toContain(sentinel);
    }
  });

  it('the unwrapped platform source would have leaked them (the reason for the shim)', async () => {
    const { bytes } = await collectExportOutput(
      writersFor(USER_DATA_EXPORT_SOURCE)[0]!,
      USER_DATA_EXPORT_SOURCE.collect(ctx('user'), {}),
    );
    expect(exportFileText(bytes)).toContain(exportSentinel('StorageObject', 'storageKey'));
  });
});
