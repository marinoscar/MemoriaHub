import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MEMORIAHUB_RAW_SQL_INDEXES, checkFragmentDeclarations, listPackageFragments, scanFragmentIndexes } from '../src/index.js';
import { PACKAGE_DIR } from './helpers.js';

const schemaDir = join(PACKAGE_DIR, 'schema');
const fragments = listPackageFragments(schemaDir).map((name) => ({ file: `schema/${name}`, text: readFileSync(join(schemaDir, name), 'utf8') }));

describe('raw-SQL index tripwire', () => {
  it('finds no fragment that redeclares a listed index', () => {
    expect(checkFragmentDeclarations(fragments, MEMORIAHUB_RAW_SQL_INDEXES)).toEqual([]);
  });

  it('reads the declarations of the real fragments (the scan is not vacuous)', () => {
    const all = fragments.flatMap((fragment) => scanFragmentIndexes(fragment.file, fragment.text));
    expect(all.length).toBeGreaterThan(50);
    // Plain b-trees sit next to the raw-SQL ones; the scan reads both kinds.
    expect(all.some((d) => d.table === 'media_items' && d.kind === '@@index')).toBe(true);
  });

  const review = fragments.find((fragment) => fragment.file.endsWith('memoriahub.review.prisma'))!;
  const media = fragments.find((fragment) => fragment.file.endsWith('memoriahub.media.prisma'))!;

  it('fails when a fragment adds @@unique on the columns of a partial unique index', () => {
    const edited = review.text.replace('model ReviewRunItem {\n', 'model ReviewRunItem {\n  @@unique([runId, burstGroupId])\n');
    expect(edited).not.toBe(review.text);
    const problems = checkFragmentDeclarations([{ file: review.file, text: edited }], MEMORIAHUB_RAW_SQL_INDEXES);
    expect(problems.map((p) => p.code)).toEqual(['FRAGMENT_DECLARES_RAW_INDEX']);
    expect(problems[0]?.message).toContain('review_run_items_run_id_burst_group_id_key');
  });

  it('fails when a fragment declares an index under the name of a listed one', () => {
    const edited = media.text.replace('model MediaItem {\n', 'model MediaItem {\n  @@index([circleId], map: "media_items_gallery_idx")\n');
    expect(edited).not.toBe(media.text);
    const problems = checkFragmentDeclarations([{ file: media.file, text: edited }], MEMORIAHUB_RAW_SQL_INDEXES);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('media_items_gallery_idx');
  });

  it('fails on a single-field @unique over the same key', () => {
    const text = 'model Probe {\n  label String? @unique\n  @@map("probes")\n}\n';
    const problems = checkFragmentDeclarations([{ file: 'f.prisma', text }], [
      { name: 'x_idx', table: 'probes', definition: 'CREATE UNIQUE INDEX x_idx ON public.probes USING btree (label) WHERE (label IS NOT NULL)' },
    ]);
    expect(problems).toHaveLength(1);
  });
});
