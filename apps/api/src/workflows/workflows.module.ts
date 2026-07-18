import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { CirclesModule } from '../circles/circles.module';
import { MediaModule } from '../media/media.module';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowDefinitionValidator } from './definition/workflow-definition.validator';
import { WorkflowConditionCompiler } from './compiler/workflow-condition.compiler';

/**
 * Media Workflow Automation — Phase 1 (issue #139). Definition, validation,
 * compilation, and preview only — no run/execution logic (Phase 2 #140).
 */
@Module({
  imports: [PrismaModule, SettingsModule, CirclesModule, MediaModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService, WorkflowDefinitionValidator, WorkflowConditionCompiler],
  exports: [WorkflowDefinitionValidator, WorkflowConditionCompiler],
})
export class WorkflowsModule {}
