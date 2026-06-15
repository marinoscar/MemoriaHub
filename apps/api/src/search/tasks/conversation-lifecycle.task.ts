import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { AiSettingsService } from '../../ai/ai-settings.service';

/**
 * Pure helper — computes which conversations should be archived or soft-deleted
 * given a point-in-time snapshot. Exported for unit testability without DB.
 */
export function computeLifecycleActions(
  now: Date,
  archiveAfterDays: number,
  deleteAfterArchiveDays: number,
  conversations: Array<{
    id: string;
    favorite: boolean;
    updatedAt: Date;
    archivedAt: Date | null;
    deletedAt: Date | null;
  }>,
): { toArchive: string[]; toDelete: string[] } {
  const archiveCutoff = new Date(now.getTime() - archiveAfterDays * 24 * 60 * 60 * 1000);
  const deleteCutoff = new Date(now.getTime() - deleteAfterArchiveDays * 24 * 60 * 60 * 1000);

  const toArchive: string[] = [];
  const toDelete: string[] = [];

  for (const c of conversations) {
    if (c.deletedAt !== null) continue;
    if (c.favorite) continue;

    if (c.archivedAt === null && c.updatedAt < archiveCutoff) {
      toArchive.push(c.id);
    } else if (c.archivedAt !== null && c.archivedAt < deleteCutoff) {
      toDelete.push(c.id);
    }
  }

  return { toArchive, toDelete };
}

@Injectable()
export class ConversationLifecycleTask {
  private readonly logger = new Logger(ConversationLifecycleTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiSettings: AiSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async handleCron(): Promise<void> {
    this.logger.log('Running conversation lifecycle task');

    const settings = await this.aiSettings.getSettings();
    const { archiveAfterDays, deleteAfterArchiveDays } = settings.conversations;

    const now = new Date();

    // Archive: active conversations not touched within the configured window,
    // ignoring favorites (which are kept indefinitely).
    const archiveCutoff = new Date(now.getTime() - archiveAfterDays * 24 * 60 * 60 * 1000);
    const archiveResult = await this.prisma.searchConversation.updateMany({
      where: {
        archivedAt: null,
        favorite: false,
        deletedAt: null,
        updatedAt: { lt: archiveCutoff },
      },
      data: { archivedAt: now },
    });

    // Soft-delete: already-archived conversations whose archivedAt exceeds the
    // delete-after-archive window, still ignoring favorites.
    const deleteCutoff = new Date(now.getTime() - deleteAfterArchiveDays * 24 * 60 * 60 * 1000);
    const deleteResult = await this.prisma.searchConversation.updateMany({
      where: {
        archivedAt: { not: null, lt: deleteCutoff },
        favorite: false,
        deletedAt: null,
      },
      data: { deletedAt: now },
    });

    this.logger.log(
      `Conversation lifecycle: ${archiveResult.count} archived, ${deleteResult.count} soft-deleted`,
    );
  }
}
