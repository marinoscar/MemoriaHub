/**
 * test/backup/headless-restore.spec.ts — `backup restore` presentation layer
 * (issue #321): the human plan/summary blocks and the `--json` NDJSON stream.
 *
 * Mirrors headless-backup.spec.ts: the renderer only consumes events, so a
 * bare RestoreEmitter stands in for the engine.
 */

import { jest } from '@jest/globals';
import {
  RESTORE_EV,
  RestoreEmitter,
  type RestorePlan,
  type RestoreSummary,
} from '../../src/backup/restore-engine.js';
import { renderRestoreHeadless } from '../../src/render/headless-restore.js';

function samplePlan(overrides: Partial<RestorePlan> = {}): RestorePlan {
  return {
    dryRun: false,
    includeTrashed: false,
    skipMetadata: false,
    concurrency: 2,
    totalItems: 3,
    totalBytes: 3072,
    alreadyRestored: 0,
    circles: [
      {
        sourceCircleId: 'src-1',
        sourceCircleName: 'Family',
        targetCircleId: 'circle-family',
        targetCircleName: 'Family',
        resolution: 'matched-by-name',
        items: 2,
        bytes: 2048,
        albums: 1,
        people: 2,
        tags: 3,
        alreadyRestored: 0,
      },
      {
        sourceCircleId: 'src-2',
        sourceCircleName: 'Work',
        targetCircleId: null,
        targetCircleName: 'Work',
        resolution: 'create',
        items: 1,
        bytes: 1024,
        albums: 0,
        people: 0,
        tags: 0,
        alreadyRestored: 0,
      },
    ],
    ...overrides,
  };
}

function sampleSummary(overrides: Partial<RestoreSummary> = {}): RestoreSummary {
  return {
    dryRun: false,
    plan: samplePlan(),
    uploaded: 2,
    skippedExisting: 1,
    failed: 0,
    metadataApplied: 2,
    tagLinks: 4,
    albumLinks: 2,
    albumsCreated: 1,
    peopleLinks: 2,
    archived: 1,
    circlesCreated: 1,
    bytesUploaded: 2048,
    failures: [],
    durationMs: 4200,
    ...overrides,
  };
}

describe('renderRestoreHeadless (human mode)', () => {
  let out: string[];
  let spy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    out = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('prints the circle mapping and per-circle totals from the plan', () => {
    const emitter = new RestoreEmitter();
    renderRestoreHeadless(emitter, { json: false });
    emitter.emit(RESTORE_EV.PLAN, samplePlan({ dryRun: true }));

    const text = out.join('');
    expect(text).toContain('dry run');
    expect(text).toContain('Family (src-1)');
    expect(text).toContain('circle-family');
    expect(text).toContain('matched-by-name');
    expect(text).toContain('would be created');
    expect(text).toContain('2 item(s)');
    expect(text).toContain('1 album(s), 2 person(s), 3 tag(s)');
    expect(text).toContain('quarantined items are never restored');
    expect(text).toContain('no bytes uploaded');
  });

  it('prints a summary with the enrichment reminder', () => {
    const emitter = new RestoreEmitter();
    renderRestoreHeadless(emitter, { json: false });
    emitter.emit(RESTORE_EV.FINISHED, { summary: sampleSummary() });

    const text = out.join('');
    expect(text).toContain('Uploaded');
    expect(text).toContain('Skipped (exists) : 1');
    expect(text).toContain('Metadata applied : 2');
    expect(text).toContain('4 tag link(s)');
    expect(text).toContain('1 re-archived');
    expect(text).toContain('Circles created  : 1');
    // Faces are not restorable — the summary has to say so.
    expect(text).toContain('re-detected by enrichment');
  });

  it('lists failures with their reasons', () => {
    const emitter = new RestoreEmitter();
    renderRestoreHeadless(emitter, { json: false });
    emitter.emit(RESTORE_EV.FINISHED, {
      summary: sampleSummary({
        failed: 1,
        failures: [{ scope: 'item', relPath: 'media/2024/03/A.jpg', error: 'upload exploded' }],
      }),
    });

    const text = out.join('');
    expect(text).toContain('1 failure(s)');
    expect(text).toContain('media/2024/03/A.jpg');
    expect(text).toContain('upload exploded');
    expect(text).toContain('restored items are skipped');
  });

  it('prints nothing but the plan for a dry run summary', () => {
    const emitter = new RestoreEmitter();
    renderRestoreHeadless(emitter, { json: false });
    out.length = 0;
    emitter.emit(RESTORE_EV.FINISHED, { summary: sampleSummary({ dryRun: true }) });
    expect(out.join('')).not.toContain('Restore summary');
  });
});

describe('renderRestoreHeadless (--json NDJSON mode)', () => {
  it('emits one parseable JSON line per event and never touches stdout', () => {
    const lines: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    try {
      const emitter = new RestoreEmitter();
      renderRestoreHeadless(emitter, { json: true, write: (line) => lines.push(line) });
      emitter.emit(RESTORE_EV.PLAN, samplePlan());
      emitter.emit(RESTORE_EV.ITEM_DONE, {
        mediaItemId: 'i1',
        relPath: 'media/2024/03/A.jpg',
        outcome: 'uploaded',
        bytes: 1024,
      });
      emitter.emit(RESTORE_EV.METADATA, { kind: 'tags', applied: 2 });
      emitter.emit(RESTORE_EV.FINISHED, { summary: sampleSummary() });
    } finally {
      spy.mockRestore();
    }

    expect(spy).not.toHaveBeenCalled();
    const parsed = lines.map((l) => {
      expect(l.endsWith('\n')).toBe(true);
      return JSON.parse(l) as Record<string, unknown>;
    });
    expect(parsed.map((p) => p['event'])).toEqual([
      'restore-plan',
      'restore-item-done',
      'restore-metadata',
      'restore-finished',
    ]);
    expect((parsed[0]!['plan'] as RestorePlan).totalItems).toBe(3);
    expect(parsed[1]!['outcome']).toBe('uploaded');
    expect((parsed[3]!['summary'] as RestoreSummary).uploaded).toBe(2);
  });
});
