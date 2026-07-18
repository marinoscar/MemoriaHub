/**
 * Unit tests for WorkflowTriggerListener (Media Workflow Automation Phase 4,
 * issue #142) -- the on_media_enriched settlement listener.
 *
 * Covers:
 *   - master switches: features.workflows off, workflows.triggers.onEnrichment
 *     off -> no enqueue.
 *   - backpressure: no on_media_enriched workflow in the circle -> the common
 *     bulk-import case costs exactly one indexed query and returns.
 *   - scoped-to-settled-dependency (the Phase-4 fix, commit 9b6f0bb3): a
 *     workflow only reacts when the JUST-settled dependency is one it reads --
 *     a metadata-only workflow does not re-enqueue on a tags/faces/etc.
 *     settlement, and a tags-only workflow does not enqueue on a faces
 *     settlement.
 *   - full dependency-set gating: a multi-dependency workflow enqueues only once
 *     EVERY dependency it reads is settled, not on the first one to settle.
 *   - failed/absent-outcome dependencies still count as settled ("terminal"
 *     includes failed / no_faces / no-group-formed) so an item is never
 *     stranded.
 *   - loop protection (1): ENRICHMENT_JOB_SETTLED only reacts to reason=upload.
 *   - defensive handling of a malformed workflow definition.
 *   - never rethrows on an internal error.
 *
 * No database required -- PrismaService and the injected services are mocked;
 * WorkflowConditionCompiler is a real (pure, no I/O) instance, same precedent
 * as workflows.service.spec.ts.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { JobReason } from '@prisma/client';
import { randomUUID } from 'crypto';
import { WorkflowTriggerListener } from './workflow-trigger.listener';
import { WorkflowConditionCompiler } from '../compiler/workflow-condition.compiler';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { EnrichmentJobService } from '../../enrichment/enrichment-job.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../../common/types/settings.types';
import { EnrichmentJobSettledEvent } from '../../enrichment/events/enrichment-job-settled.event';
import { ObjectProcessedEvent } from '../../storage/processing/events/object-processed.event';
import { WorkflowDefinition } from '../definition/workflow-definition.schema';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';

const CIRCLE_ID = randomUUID();
const MEDIA_ITEM_ID = randomUUID();
const WORKFLOW_ID = randomUUID();
const STORAGE_OBJECT_ID = randomUUID();

function settingsWithWorkflows(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_SYSTEM_SETTINGS,
    features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: true },
    workflows: { ...DEFAULT_SYSTEM_SETTINGS.workflows, ...overrides },
  };
}

function def(conditions: Array<Record<string, unknown>>): WorkflowDefinition {
  return {
    version: 1,
    subject: 'media_item',
    match: 'all',
    conditions,
    actions: [{ type: 'move_to_trash' }],
  } as WorkflowDefinition;
}

const NO_CONDITION_DEF = def([]);
const TAGS_ONLY_DEF = def([{ field: 'tags', op: 'has_any', value: ['x'] }]);
const FACES_ONLY_DEF = def([
  { field: 'people', op: 'has_person', value: { ids: [randomUUID()] } },
]);
const TAGS_AND_FACES_DEF = def([
  { field: 'tags', op: 'has_any', value: ['x'] },
  { field: 'people', op: 'has_person', value: { ids: [randomUUID()] } },
]);
const BURSTS_ONLY_DEF = def([{ field: 'inPendingBurstGroup', op: 'is', value: true }]);
const DUPLICATES_ONLY_DEF = def([{ field: 'inPendingDuplicateGroup', op: 'is', value: true }]);
const LOCATION_ONLY_DEF = def([
  { field: 'hasPendingLocationSuggestion', op: 'is', value: true },
]);

describe('WorkflowTriggerListener', () => {
  let listener: WorkflowTriggerListener;
  let prisma: MockPrismaService;
  let systemSettings: jest.Mocked<Pick<SystemSettingsService, 'getSettings'>>;
  let enrichmentJobs: jest.Mocked<Pick<EnrichmentJobService, 'enqueue'>>;

  beforeEach(async () => {
    prisma = createMockPrismaService();
    systemSettings = {
      getSettings: jest.fn().mockResolvedValue(settingsWithWorkflows()),
    };
    enrichmentJobs = {
      enqueue: jest.fn().mockResolvedValue({ id: randomUUID() } as any),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowTriggerListener,
        WorkflowConditionCompiler,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemSettingsService, useValue: systemSettings },
        { provide: EnrichmentJobService, useValue: enrichmentJobs },
      ],
    }).compile();

    listener = module.get(WorkflowTriggerListener);

    // Default fully-settled snapshot: no in-flight producers, all statuses
    // terminal/negative (features off by default in DEFAULT_SYSTEM_SETTINGS, so
    // tags/faces/bursts/duplicates/locationSuggestions all settle vacuously).
    prisma.mediaItem.findUnique.mockResolvedValue({
      type: 'photo',
      burstGroupId: null,
      duplicateGroupId: null,
      socialMediaSource: null,
    } as any);
    prisma.mediaTagStatus.findUnique.mockResolvedValue(null);
    prisma.mediaFaceStatus.findUnique.mockResolvedValue(null);
    prisma.locationSuggestion.findUnique.mockResolvedValue(null);
    prisma.enrichmentJob.findMany.mockResolvedValue([]);
  });

  function mockWorkflows(rows: Array<{ id: string; definition: WorkflowDefinition }>): void {
    prisma.workflow.findMany.mockResolvedValue(rows as any);
  }

  // ---------------------------------------------------------------------------
  // Master switches
  // ---------------------------------------------------------------------------

  describe('master switches', () => {
    it('does not enqueue when features.workflows is disabled', async () => {
      systemSettings.getSettings.mockResolvedValue({
        ...DEFAULT_SYSTEM_SETTINGS,
        features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: false },
      } as any);
      mockWorkflows([{ id: WORKFLOW_ID, definition: NO_CONDITION_DEF }]);

      await listener.handleObjectProcessed(
        new ObjectProcessedEvent(STORAGE_OBJECT_ID) as any,
      );

      expect(prisma.workflow.findMany).not.toHaveBeenCalled();
      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });

    it('does not enqueue when workflows.triggers.onEnrichment is explicitly false', async () => {
      systemSettings.getSettings.mockResolvedValue(
        settingsWithWorkflows({ triggers: { onEnrichment: false, scheduled: true } }) as any,
      );
      prisma.mediaItem.findUnique.mockResolvedValueOnce({
        id: MEDIA_ITEM_ID,
        circleId: CIRCLE_ID,
      } as any);

      await listener.handleObjectProcessed(
        new ObjectProcessedEvent(STORAGE_OBJECT_ID) as any,
      );

      expect(prisma.workflow.findMany).not.toHaveBeenCalled();
      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Backpressure
  // ---------------------------------------------------------------------------

  describe('backpressure', () => {
    it('costs exactly one indexed workflow query and returns when the circle has no on_media_enriched workflow', async () => {
      // The resolver used by handleObjectProcessed to map storageObjectId -> mediaItem.
      const findUniqueSpy = prisma.mediaItem.findUnique as jest.Mock;
      findUniqueSpy.mockReset();
      findUniqueSpy.mockResolvedValueOnce({ id: MEDIA_ITEM_ID, circleId: CIRCLE_ID });
      mockWorkflows([]);

      await listener.handleObjectProcessed(
        new ObjectProcessedEvent(STORAGE_OBJECT_ID) as any,
      );

      expect(prisma.workflow.findMany).toHaveBeenCalledTimes(1);
      // buildDependencyState is never reached -- no further mediaItem lookup.
      expect(findUniqueSpy).toHaveBeenCalledTimes(1);
      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Scoped-to-settled-dependency (the Phase-4 fan-out fix)
  // ---------------------------------------------------------------------------

  describe('scoped to the settled dependency', () => {
    it('a no-condition (metadata-only) workflow enqueues on the metadata (OBJECT_PROCESSED) signal', async () => {
      const findUniqueSpy = prisma.mediaItem.findUnique as jest.Mock;
      findUniqueSpy.mockReset();
      findUniqueSpy
        .mockResolvedValueOnce({ id: MEDIA_ITEM_ID, circleId: CIRCLE_ID }) // storageObjectId resolve
        .mockResolvedValueOnce({
          type: 'photo',
          burstGroupId: null,
          duplicateGroupId: null,
          socialMediaSource: null,
        }); // buildDependencyState
      mockWorkflows([{ id: WORKFLOW_ID, definition: NO_CONDITION_DEF }]);

      await listener.handleObjectProcessed(
        new ObjectProcessedEvent(STORAGE_OBJECT_ID) as any,
      );

      expect(enrichmentJobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'workflow_evaluate_item',
          mediaItemId: MEDIA_ITEM_ID,
          circleId: CIRCLE_ID,
          priority: 50,
          skipDedup: true,
          payload: { workflowId: WORKFLOW_ID, mediaItemId: MEDIA_ITEM_ID },
        }),
      );
    });

    it('a no-condition (metadata-only) workflow does NOT re-enqueue on a subsequent tags settlement', async () => {
      mockWorkflows([{ id: WORKFLOW_ID, definition: NO_CONDITION_DEF }]);

      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'auto_tagging',
          JobReason.upload,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'succeeded',
        ),
      );

      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });

    it('a tags-only workflow enqueues on a tags settlement but NOT on a faces settlement', async () => {
      mockWorkflows([{ id: WORKFLOW_ID, definition: TAGS_ONLY_DEF }]);

      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'face_detection',
          JobReason.upload,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'succeeded',
        ),
      );
      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();

      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'auto_tagging',
          JobReason.upload,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'succeeded',
        ),
      );
      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['burst_detection', BURSTS_ONLY_DEF],
      ['duplicate_detection', DUPLICATES_ONLY_DEF],
      ['location_inference', LOCATION_ONLY_DEF],
    ])('a review-queue-only workflow reacts to its own producer type (%s)', async (jobType, workflowDef) => {
      mockWorkflows([{ id: WORKFLOW_ID, definition: workflowDef as WorkflowDefinition }]);

      // A settlement of an UNRELATED producer must not enqueue.
      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'auto_tagging',
          JobReason.upload,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'succeeded',
        ),
      );
      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();

      // The matching producer's settlement enqueues.
      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          jobType,
          JobReason.upload,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'succeeded',
        ),
      );
      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Full dependency-set gating
  // ---------------------------------------------------------------------------

  describe('full dependency-set gating (multi-dependency workflows)', () => {
    it('does not enqueue on the first settled dependency while a second dependency the workflow reads is still unsettled', async () => {
      // Feature flags: enable both auto-tagging and face recognition so both
      // dependencies are "real" (not vacuously settled by feature-off).
      systemSettings.getSettings.mockResolvedValue({
        ...settingsWithWorkflows(),
        features: {
          ...DEFAULT_SYSTEM_SETTINGS.features,
          workflows: true,
          autoTagging: true,
          faceRecognition: true,
        },
      } as any);
      mockWorkflows([{ id: WORKFLOW_ID, definition: TAGS_AND_FACES_DEF }]);

      // tags settled (processed), faces NOT yet settled (pending status, no
      // in-flight-producer escape hatch applicable -- a photo, not a social video).
      prisma.mediaTagStatus.findUnique.mockResolvedValue({ status: 'processed' } as any);
      prisma.mediaFaceStatus.findUnique.mockResolvedValue({ status: 'pending' } as any);
      prisma.enrichmentJob.findMany.mockResolvedValue([
        { type: 'face_detection' },
      ] as any); // face_detection still in flight

      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'auto_tagging',
          JobReason.upload,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'succeeded',
        ),
      );

      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });

    it('enqueues once the LAST-completing dependency settles', async () => {
      systemSettings.getSettings.mockResolvedValue({
        ...settingsWithWorkflows(),
        features: {
          ...DEFAULT_SYSTEM_SETTINGS.features,
          workflows: true,
          autoTagging: true,
          faceRecognition: true,
        },
      } as any);
      mockWorkflows([{ id: WORKFLOW_ID, definition: TAGS_AND_FACES_DEF }]);

      // Now both are terminal: tags processed, faces processed, nothing in flight.
      prisma.mediaTagStatus.findUnique.mockResolvedValue({ status: 'processed' } as any);
      prisma.mediaFaceStatus.findUnique.mockResolvedValue({ status: 'processed' } as any);
      prisma.enrichmentJob.findMany.mockResolvedValue([]);

      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'face_detection',
          JobReason.upload,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'succeeded',
        ),
      );

      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Failed / negative outcomes still settle (never strand the item)
  // ---------------------------------------------------------------------------

  describe('failed and empty-outcome dependencies still count as settled', () => {
    it('a tags-dependent workflow evaluates even when tagging FAILED (not just processed)', async () => {
      systemSettings.getSettings.mockResolvedValue({
        ...settingsWithWorkflows(),
        features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: true, autoTagging: true },
      } as any);
      mockWorkflows([{ id: WORKFLOW_ID, definition: TAGS_ONLY_DEF }]);
      prisma.mediaTagStatus.findUnique.mockResolvedValue({ status: 'failed' } as any);

      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'auto_tagging',
          JobReason.upload,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'failed',
        ),
      );

      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(1);
    });

    it('a bursts-dependent workflow evaluates once no burst group formed and nothing is still in flight (no-group-formed terminal)', async () => {
      systemSettings.getSettings.mockResolvedValue({
        ...settingsWithWorkflows(),
        features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: true, burstDetection: true },
      } as any);
      mockWorkflows([{ id: WORKFLOW_ID, definition: BURSTS_ONLY_DEF }]);
      prisma.mediaItem.findUnique.mockResolvedValue({
        type: 'photo',
        burstGroupId: null, // no group formed
        duplicateGroupId: null,
        socialMediaSource: null,
      } as any);
      prisma.enrichmentJob.findMany.mockResolvedValue([]); // burst_detection no longer in flight

      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'burst_detection',
          JobReason.upload,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'succeeded',
        ),
      );

      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(1);
    });

    it('a faces-dependent workflow evaluates for a social-media video with no face job in flight (skipped, not run)', async () => {
      systemSettings.getSettings.mockResolvedValue({
        ...settingsWithWorkflows(),
        features: { ...DEFAULT_SYSTEM_SETTINGS.features, workflows: true, faceRecognition: true },
      } as any);
      mockWorkflows([{ id: WORKFLOW_ID, definition: FACES_ONLY_DEF }]);
      prisma.mediaItem.findUnique.mockResolvedValue({
        type: 'video',
        burstGroupId: null,
        duplicateGroupId: null,
        socialMediaSource: 'tiktok',
      } as any);
      prisma.mediaFaceStatus.findUnique.mockResolvedValue(null); // never processed -- skipped
      prisma.enrichmentJob.findMany.mockResolvedValue([]); // no face_detection/video_face_detection in flight

      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'video_face_detection',
          JobReason.upload,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'succeeded',
        ),
      );

      expect(enrichmentJobs.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Loop protection (1): only reason=upload re-settles workflows
  // ---------------------------------------------------------------------------

  describe('loop protection', () => {
    it('ignores an ENRICHMENT_JOB_SETTLED event with reason=rerun (a workflow-applied re-enqueue)', async () => {
      mockWorkflows([{ id: WORKFLOW_ID, definition: TAGS_ONLY_DEF }]);

      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'auto_tagging',
          JobReason.rerun,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'succeeded',
        ),
      );

      expect(prisma.workflow.findMany).not.toHaveBeenCalled();
      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });

    it('ignores an ENRICHMENT_JOB_SETTLED event with reason=backfill', async () => {
      mockWorkflows([{ id: WORKFLOW_ID, definition: TAGS_ONLY_DEF }]);

      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'auto_tagging',
          JobReason.backfill,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'succeeded',
        ),
      );

      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });

    it('ignores a job type with no workflow-relevant dependency mapping', async () => {
      mockWorkflows([{ id: WORKFLOW_ID, definition: NO_CONDITION_DEF }]);

      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'storage_insights', // maps to no WorkflowDependency
          JobReason.upload,
          MEDIA_ITEM_ID,
          CIRCLE_ID,
          'succeeded',
        ),
      );

      expect(prisma.workflow.findMany).not.toHaveBeenCalled();
      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });

    it('ignores a global job event with no mediaItemId/circleId', async () => {
      mockWorkflows([{ id: WORKFLOW_ID, definition: NO_CONDITION_DEF }]);

      await listener.handleJobSettled(
        new EnrichmentJobSettledEvent(
          randomUUID(),
          'auto_tagging',
          JobReason.upload,
          null,
          null,
          'succeeded',
        ),
      );

      expect(enrichmentJobs.enqueue).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Defensive handling
  // ---------------------------------------------------------------------------

  describe('defensive handling', () => {
    it('skips a workflow whose definition fails to compile (deriveDependencies throws) without affecting other workflows', async () => {
      const otherWorkflowId = randomUUID();
      mockWorkflows([
        { id: WORKFLOW_ID, definition: { version: 1, subject: 'media_item' } as any }, // malformed: no conditions/actions
        { id: otherWorkflowId, definition: NO_CONDITION_DEF },
      ]);

      await listener.handleObjectProcessed(
        new ObjectProcessedEvent(STORAGE_OBJECT_ID) as any,
      );

      // The healthy workflow still enqueues; the malformed one does not crash the loop.
      const calls = (enrichmentJobs.enqueue as jest.Mock).mock.calls;
      expect(calls.some((c) => c[0].payload.workflowId === otherWorkflowId)).toBe(true);
      expect(calls.some((c) => c[0].payload.workflowId === WORKFLOW_ID)).toBe(false);
    });

    it('handleObjectProcessed never rethrows even when the mediaItem lookup fails', async () => {
      prisma.mediaItem.findUnique.mockRejectedValueOnce(new Error('db exploded'));

      await expect(
        listener.handleObjectProcessed(
          new ObjectProcessedEvent(STORAGE_OBJECT_ID) as any,
        ),
      ).resolves.not.toThrow();
    });

    it('handleJobSettled never rethrows even when the settings lookup fails', async () => {
      systemSettings.getSettings.mockRejectedValue(new Error('settings unavailable'));

      await expect(
        listener.handleJobSettled(
          new EnrichmentJobSettledEvent(
            randomUUID(),
            'auto_tagging',
            JobReason.upload,
            MEDIA_ITEM_ID,
            CIRCLE_ID,
            'succeeded',
          ),
        ),
      ).resolves.not.toThrow();
    });

    it('handleObjectProcessed no-ops when no MediaItem is found for the StorageObject', async () => {
      prisma.mediaItem.findUnique.mockResolvedValueOnce(null);

      await listener.handleObjectProcessed(
        new ObjectProcessedEvent(STORAGE_OBJECT_ID) as any,
      );

      expect(prisma.workflow.findMany).not.toHaveBeenCalled();
    });
  });
});
