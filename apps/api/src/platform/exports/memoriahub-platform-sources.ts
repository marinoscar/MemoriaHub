// =============================================================================
// The platform's `user-data` and `org-data` sources, with MemoriaHub's extra redaction
// (RETRO-H2, #596)
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(#596): the platform registers `StorageObject` in the user-owned
// registry itself (`registerPlatformUserOwnedModels`, `export: 'include'`, no `exportOmit`),
// so its `user-data` source writes each of the user's `storage_objects` rows WITH its
// `storageKey`, `bucket`, `s3UploadId` and `metadata` (MemoriaHub's `metadata` holds the
// thumbnail keys and the processing results), and `org-data` writes every row of the
// organization the same way. An app cannot add an `exportOmit` to an entry the platform
// registered (a second registration of the model is refused), and #596 requires that no
// storage key appears in ANY export.
//
// So `exports.config.ts` turns the two platform sources off (`platformSources`) and this
// file registers them again under their PERMANENT ids (`user-data`, `org-data`), with the
// platform's own `collect`, label, permissions and writers, wrapped by
// `withoutColumns`: the listed columns are removed from the dataset's column list and from
// every row before any writer runs. Everything else is the platform's.
//
// Seam request: let an app extend the redaction of a platform-registered model (an
// `exportOmit` augmentation, or a column-redaction hook on the sources). When it ships,
// delete this file, set `platformSources` back to the defaults and move the list below
// into that hook.
// =============================================================================

import {
  ORG_DATA_EXPORT_SOURCE,
  USER_DATA_EXPORT_SOURCE,
  type ExportCell,
  type ExportContext,
  type ExportSource,
  type ExportTable,
} from '@marinoscar/platform-api/exports';

/**
 * Columns removed from a platform dataset, by dataset name. `storage_object`: the object's
 * address in the bucket and the processing metadata (thumbnail keys) never leave the server;
 * the name, size, type, status and dates stay, as the manifest of the user's files.
 */
export const MEMORIAHUB_PLATFORM_DATASET_REDACTIONS: Readonly<Record<string, readonly string[]>> = {
  storage_object: ['storageKey', 'bucket', 's3UploadId', 'metadata'],
};

/** `tables` with the listed columns of each dataset removed (from the header and every row). */
export async function* withoutColumns(
  tables: AsyncIterable<ExportTable>,
  redactions: Readonly<Record<string, readonly string[]>> = MEMORIAHUB_PLATFORM_DATASET_REDACTIONS,
): AsyncGenerator<ExportTable> {
  for await (const table of tables) {
    const drop = new Set(redactions[table.dataset] ?? []);
    if (drop.size === 0) {
      yield table;
      continue;
    }
    const columns = table.columns.filter((column) => !drop.has(column.key));
    const keys = columns.map((column) => column.key);
    const source = table.rows;
    yield {
      ...table,
      columns,
      rows: (async function* () {
        for await (const row of source) {
          const kept: Record<string, ExportCell> = {};
          for (const key of keys) kept[key] = row[key] ?? null;
          yield kept;
        }
      })(),
    };
  }
}

function redacted<Req>(source: ExportSource<Req>): ExportSource<Req> {
  return {
    ...source,
    collect: (ctx: ExportContext, req: Req) => withoutColumns(source.collect(ctx, req)),
  };
}

/** The platform's `user-data`, with MemoriaHub's extra redaction. Same id, permanent. */
export const MEMORIAHUB_USER_DATA_EXPORT_SOURCE = redacted(USER_DATA_EXPORT_SOURCE);

/** The platform's `org-data`, with MemoriaHub's extra redaction. Same id, permanent. */
export const MEMORIAHUB_ORG_DATA_EXPORT_SOURCE = redacted(ORG_DATA_EXPORT_SOURCE);
