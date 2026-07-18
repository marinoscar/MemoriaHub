import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { CirclesModule } from '../circles/circles.module';
import { MediaModule } from '../media/media.module';
import { FaceModule } from '../face/face.module';
import { BurstModule } from '../burst/burst.module';
import { DedupModule } from '../dedup/dedup.module';
import { LocationInferenceModule } from '../location-inference/location-inference.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowDefinitionValidator } from './definition/workflow-definition.validator';
import { WorkflowConditionCompiler } from './compiler/workflow-condition.compiler';
import { WorkflowActionExecutor } from './actions/workflow-action.executor';

/**
 * Media Workflow Automation — Phase 2 action library (issue #140).
 *
 * Phase 1 covered definition, validation, compilation, and preview. This phase
 * adds the injectable WorkflowActionExecutor (the "Then" half); the run
 * lifecycle / queue handlers / HTTP endpoints are a separate turn.
 *
 * The executor reuses domain services verbatim, so this module imports the
 * modules that own them (each re-exports the injected service):
 *   - MediaModule            → MediaService, MediaEnrichmentService
 *   - FaceModule             → PeopleService
 *   - BurstModule            → BurstService
 *   - DedupModule            → DuplicateService
 *   - LocationInferenceModule → LocationSuggestionService
 *   - EnrichmentModule       → EnrichmentJobService
 *   - CirclesModule          → CircleMembershipService
 * None of these import WorkflowsModule, so no forwardRef is required.
 */
@Module({
  imports: [
    PrismaModule,
    SettingsModule,
    CirclesModule,
    MediaModule,
    FaceModule,
    BurstModule,
    DedupModule,
    LocationInferenceModule,
    EnrichmentModule,
  ],
  controllers: [WorkflowsController],
  providers: [
    WorkflowsService,
    WorkflowDefinitionValidator,
    WorkflowConditionCompiler,
    WorkflowActionExecutor,
  ],
  exports: [WorkflowDefinitionValidator, WorkflowConditionCompiler, WorkflowActionExecutor],
})
export class WorkflowsModule {}
