// =============================================================================
// PeopleService
// =============================================================================

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { CircleRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { FaceClusteringService } from './face-clustering.service';
import { FaceMatchingService } from './face-matching.service';
import {
  ListPeopleQueryDto,
  CreatePersonDto,
  UpdatePersonDto,
  AssignFacesDto,
  ListUnassignedFacesQueryDto,
} from './dto/people.dto';
import { MergePeopleDto } from './dto/merge-people.dto';

@Injectable()
export class PeopleService {
  private readonly logger = new Logger(PeopleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembershipService: CircleMembershipService,
    private readonly clusteringService: FaceClusteringService,
    private readonly matchingService: FaceMatchingService,
  ) {}

  // ---------------------------------------------------------------------------
  // listPeople
  // ---------------------------------------------------------------------------

  async listPeople(
    query: ListPeopleQueryDto,
    userId: string,
    userPermissions: string[],
  ) {
    const { circleId, includeUnlabeled, page, pageSize } = query;

    await this.circleMembershipService.assertCircleAccess(
      userId,
      circleId,
      userPermissions,
      'viewer' as CircleRole,
    );

    const skip = (page - 1) * pageSize;

    const where = {
      circleId,
      deletedAt: null,
      mergedIntoId: null,
      ...(includeUnlabeled ? {} : { name: { not: null } }),
    };

    const [persons, totalItems] = await Promise.all([
      this.prisma.person.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { faces: true } },
          coverFace: {
            select: {
              id: true,
              mediaItemId: true,
              boundingBox: true,
            },
          },
          // Fetch a small set of faces for cover-fallback resolution
          faces: {
            where: { mediaItem: { deletedAt: null } },
            orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
            take: 1,
            select: {
              id: true,
              mediaItemId: true,
              boundingBox: true,
              confidence: true,
            },
          },
        },
      }),
      this.prisma.person.count({ where }),
    ]);

    const items = persons.map((p) => ({
      id: p.id,
      name: p.name,
      isUnlabeled: p.name === null,
      faceCount: p._count.faces,
      coverFace: this.resolveCoverFace(p.coverFace, p.faces ?? []),
      profileMediaItemId: p.profileMediaItemId ?? null,
      profileCrop: p.profileCrop ?? null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));

    return {
      items,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // listUnassignedFaces
  // ---------------------------------------------------------------------------

  async listUnassignedFaces(
    userId: string,
    userPermissions: string[],
    query: ListUnassignedFacesQueryDto,
  ) {
    const { circleId, page, pageSize } = query;

    await this.circleMembershipService.assertCircleAccess(
      userId,
      circleId,
      userPermissions,
      'viewer' as CircleRole,
    );

    const skip = (page - 1) * pageSize;

    const where = {
      personId: null,
      circleId,
      mediaItem: { deletedAt: null },
    };

    const [faces, totalItems] = await Promise.all([
      this.prisma.face.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          mediaItemId: true,
          boundingBox: true,
          confidence: true,
          createdAt: true,
        },
      }),
      this.prisma.face.count({ where }),
    ]);

    const items = faces.map((f) => ({
      faceId: f.id,
      mediaItemId: f.mediaItemId,
      boundingBox: f.boundingBox,
      confidence: f.confidence,
      createdAt: f.createdAt,
    }));

    return {
      items,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // getPerson
  // ---------------------------------------------------------------------------

  async getPerson(
    personId: string,
    userId: string,
    userPermissions: string[],
  ) {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      include: {
        faces: {
          select: {
            id: true,
            mediaItemId: true,
            boundingBox: true,
            confidence: true,
            manuallyAssigned: true,
            createdAt: true,
          },
          orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
        },
        coverFace: {
          select: {
            id: true,
            mediaItemId: true,
            boundingBox: true,
          },
        },
      },
    });

    if (!person || person.deletedAt) {
      throw new NotFoundException(`Person ${personId} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(
      userId,
      person.circleId,
      userPermissions,
      'viewer' as CircleRole,
    );

    return {
      id: person.id,
      name: person.name,
      isUnlabeled: person.name === null,
      circleId: person.circleId,
      coverFace: this.resolveCoverFace(person.coverFace, person.faces),
      profileMediaItemId: person.profileMediaItemId ?? null,
      profileCrop: person.profileCrop ?? null,
      faces: person.faces.map((f) => ({
        faceId: f.id,
        mediaItemId: f.mediaItemId,
        boundingBox: f.boundingBox,
        confidence: f.confidence,
        manuallyAssigned: f.manuallyAssigned,
        createdAt: f.createdAt,
      })),
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // createPerson
  // ---------------------------------------------------------------------------

  async createPerson(
    dto: CreatePersonDto,
    userId: string,
    userPermissions: string[],
  ) {
    await this.circleMembershipService.assertCircleAccess(
      userId,
      dto.circleId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    const person = await this.prisma.person.create({
      data: {
        circleId: dto.circleId,
        addedById: userId,
        name: dto.name ?? null,
      },
    });

    if (dto.faceIds && dto.faceIds.length > 0) {
      // Verify all faces exist in the same circle
      await this.assertFacesInCircle(dto.faceIds, dto.circleId);

      await this.prisma.face.updateMany({
        where: { id: { in: dto.faceIds }, circleId: dto.circleId },
        data: { personId: person.id, manuallyAssigned: true },
      });

      // Auto-set coverFaceId to the first assigned face when none was set
      if (!person.coverFaceId) {
        await this.prisma.person.update({
          where: { id: person.id },
          data: { coverFaceId: dto.faceIds[0] },
        });
      }
    }

    this.logger.log(
      `Person created: ${person.id} (name=${person.name ?? 'unlabeled'}) by user ${userId}`,
    );

    return { id: person.id, name: person.name, circleId: person.circleId };
  }

  // ---------------------------------------------------------------------------
  // updatePerson
  // ---------------------------------------------------------------------------

  async updatePerson(
    personId: string,
    dto: UpdatePersonDto,
    userId: string,
    userPermissions: string[],
  ) {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
    });

    if (!person || person.deletedAt) {
      throw new NotFoundException(`Person ${personId} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(
      userId,
      person.circleId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    // If coverFaceId is being set, verify the face belongs to this person
    if (dto.coverFaceId !== undefined && dto.coverFaceId !== null) {
      const face = await this.prisma.face.findUnique({
        where: { id: dto.coverFaceId },
      });
      if (!face || face.personId !== personId) {
        throw new BadRequestException(
          `Face ${dto.coverFaceId} does not belong to person ${personId}`,
        );
      }
    }

    // Validate profileMediaItemId when being set (non-null)
    if (dto.profileMediaItemId != null) {
      const mediaItem = await this.prisma.mediaItem.findUnique({
        where: { id: dto.profileMediaItemId },
        select: { id: true, circleId: true, deletedAt: true },
      });

      if (!mediaItem || mediaItem.deletedAt) {
        throw new BadRequestException(
          `MediaItem ${dto.profileMediaItemId} not found`,
        );
      }

      if (mediaItem.circleId !== person.circleId) {
        throw new BadRequestException(
          `MediaItem ${dto.profileMediaItemId} does not belong to the same circle as this person`,
        );
      }

      // Assert the person actually appears in this media item (a face with this personId)
      const faceInMedia = await this.prisma.face.findFirst({
        where: { mediaItemId: dto.profileMediaItemId, personId },
        select: { id: true },
      });
      if (!faceInMedia) {
        throw new BadRequestException(
          `Person ${personId} has no detected face in MediaItem ${dto.profileMediaItemId}`,
        );
      }
    }

    // Build update data carefully to avoid Prisma relation/scalar type conflicts
    const updateData: Record<string, unknown> = {};
    if (dto.name !== undefined) updateData['name'] = dto.name;
    if (dto.coverFaceId !== undefined) updateData['coverFaceId'] = dto.coverFaceId;
    if (dto.profileMediaItemId !== undefined) {
      updateData['profileMediaItemId'] = dto.profileMediaItemId;
      updateData['profileCrop'] =
        dto.profileMediaItemId === null ? null : (dto.profileCrop ?? null);
    }

    const updated = await this.prisma.person.update({
      where: { id: personId },
      data: updateData as any,
    });

    this.logger.log(`Person updated: ${personId} by user ${userId}`);

    return {
      id: updated.id,
      name: updated.name,
      coverFaceId: updated.coverFaceId,
      profileMediaItemId: updated.profileMediaItemId ?? null,
      profileCrop: updated.profileCrop ?? null,
      updatedAt: updated.updatedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // assignFaces
  // ---------------------------------------------------------------------------

  async assignFaces(
    personId: string,
    dto: AssignFacesDto,
    userId: string,
    userPermissions: string[],
  ) {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
    });

    if (!person || person.deletedAt) {
      throw new NotFoundException(`Person ${personId} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(
      userId,
      person.circleId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    // Verify each face exists in the same circle
    await this.assertFacesInCircle(dto.faceIds, person.circleId);

    await this.prisma.face.updateMany({
      where: { id: { in: dto.faceIds }, circleId: person.circleId },
      data: { personId, manuallyAssigned: true },
    });

    // Auto-set coverFaceId to the first assigned face when person has none
    if (!person.coverFaceId) {
      await this.prisma.person.update({
        where: { id: personId },
        data: { coverFaceId: dto.faceIds[0] },
      });
    }

    this.logger.log(
      `Assigned ${dto.faceIds.length} face(s) to person ${personId} by user ${userId}`,
    );

    return { personId, assignedCount: dto.faceIds.length };
  }

  // ---------------------------------------------------------------------------
  // unassignFace
  // ---------------------------------------------------------------------------

  async unassignFace(
    personId: string,
    faceId: string,
    userId: string,
    userPermissions: string[],
  ) {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
    });

    if (!person || person.deletedAt) {
      throw new NotFoundException(`Person ${personId} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(
      userId,
      person.circleId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    const face = await this.prisma.face.findUnique({ where: { id: faceId } });

    if (!face || face.personId !== personId) {
      throw new NotFoundException(
        `Face ${faceId} not found or not assigned to person ${personId}`,
      );
    }

    await this.prisma.face.update({
      where: { id: faceId },
      data: { personId: null, manuallyAssigned: false },
    });

    this.logger.log(
      `Unassigned face ${faceId} from person ${personId} by user ${userId}`,
    );
  }

  // ---------------------------------------------------------------------------
  // clusterUnknowns
  // ---------------------------------------------------------------------------

  async clusterUnknowns(
    circleId: string,
    userId: string,
    userPermissions: string[],
  ) {
    await this.circleMembershipService.assertCircleAccess(
      userId,
      circleId,
      userPermissions,
      'circle_admin' as CircleRole,
    );

    // Require circle to have faceRecognitionEnabled
    const circle = await this.prisma.circle.findUnique({
      where: { id: circleId },
      select: { faceRecognitionEnabled: true },
    });
    if (!circle?.faceRecognitionEnabled) {
      throw new BadRequestException(
        'Face recognition is not enabled for this circle. Enable it via PUT /api/circles/:id/face-settings.',
      );
    }

    const result = await this.clusteringService.clusterUnknownFaces(
      circleId,
      userId,
    );

    this.logger.log(
      `clusterUnknowns: circle ${circleId} by user ${userId} — ` +
        `${result.clustersCreated} cluster(s), ${result.facesAssigned} face(s)`,
    );

    return result;
  }

  // ---------------------------------------------------------------------------
  // mergePeople
  // ---------------------------------------------------------------------------

  async mergePeople(
    dto: MergePeopleDto,
    userId: string,
    userPermissions: string[],
  ) {
    const { sourceId, targetId } = dto;

    const [source, target] = await Promise.all([
      this.prisma.person.findUnique({ where: { id: sourceId } }),
      this.prisma.person.findUnique({ where: { id: targetId } }),
    ]);

    if (!source || source.deletedAt) {
      throw new NotFoundException(`Source person ${sourceId} not found`);
    }
    if (!target || target.deletedAt) {
      throw new NotFoundException(`Target person ${targetId} not found`);
    }
    if (source.circleId !== target.circleId) {
      throw new BadRequestException('Both persons must belong to the same circle');
    }
    if (source.mergedIntoId !== null) {
      throw new BadRequestException(`Source person ${sourceId} has already been merged`);
    }

    const circleId = source.circleId;

    await this.circleMembershipService.assertCircleAccess(
      userId,
      circleId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    const now = new Date();

    const updatedTarget = await this.prisma.$transaction(async (tx) => {
      // 1. Reassign all faces from source to target
      await tx.face.updateMany({
        where: { personId: sourceId },
        data: { personId: targetId },
      });

      // 2. Carry over coverFace if target has none but source did
      let coverFaceId = target.coverFaceId;
      if (!coverFaceId && source.coverFaceId) {
        // source.coverFaceId face is now assigned to target
        coverFaceId = source.coverFaceId;
      }

      // 3. Soft-delete source; set mergedIntoId; clear coverFaceId
      await tx.person.update({
        where: { id: sourceId },
        data: {
          mergedIntoId: targetId,
          deletedAt: now,
          coverFaceId: null,
        },
      });

      // 4. Update target's coverFaceId if carrying it over
      const updatedT = await tx.person.update({
        where: { id: targetId },
        data: {
          ...(coverFaceId && !target.coverFaceId ? { coverFaceId } : {}),
        },
        select: {
          id: true,
          name: true,
          circleId: true,
          coverFaceId: true,
          _count: { select: { faces: true } },
          createdAt: true,
          updatedAt: true,
        },
      });

      // 5. Audit
      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          action: 'person:merge',
          targetType: 'person',
          targetId: targetId,
          meta: { sourceId, targetId, circleId } as any,
        },
      });

      return updatedT;
    });

    // 6. Recompute target centroid (best-effort; failure logged, not thrown)
    try {
      await this.matchingService.computePersonCentroid(targetId);
    } catch (err) {
      this.logger.warn(`Centroid recompute failed post-merge for person ${targetId}: ${err}`);
    }

    this.logger.log(
      `Person merge: ${sourceId} → ${targetId} in circle ${circleId} by user ${userId}`,
    );

    return {
      id: updatedTarget.id,
      name: updatedTarget.name,
      circleId: updatedTarget.circleId,
      coverFaceId: updatedTarget.coverFaceId,
      faceCount: updatedTarget._count.faces,
      mergedSourceId: sourceId,
      updatedAt: updatedTarget.updatedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // deletePerson
  // ---------------------------------------------------------------------------

  async deletePerson(
    personId: string,
    userId: string,
    userPermissions: string[],
  ) {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
    });

    if (!person || person.deletedAt) {
      throw new NotFoundException(`Person ${personId} not found`);
    }

    await this.circleMembershipService.assertCircleAccess(
      userId,
      person.circleId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    await this.prisma.$transaction(async (tx) => {
      // 1. Release faces back to unknown pool
      await tx.face.updateMany({
        where: { personId },
        data: { personId: null, manuallyAssigned: false },
      });

      // 2. Soft-delete person
      await tx.person.update({
        where: { id: personId },
        data: {
          deletedAt: new Date(),
          coverFaceId: null, // clear FK
        },
      });

      // 3. Audit
      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          action: 'person:delete',
          targetType: 'person',
          targetId: personId,
          meta: { circleId: person.circleId, name: person.name } as any,
        },
      });
    });

    this.logger.log(
      `Person ${personId} soft-deleted by user ${userId}; faces returned to unknown pool`,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve a cover face for display.
   * If the person has a persisted coverFaceId (and it was eagerly loaded), use it.
   * Otherwise fall back to the most relevant face from the provided list
   * (already sorted by confidence DESC, createdAt DESC by the caller).
   * The fallback is NOT persisted — it is purely for the response payload.
   */
  private resolveCoverFace(
    coverFace: { id: string; mediaItemId: string; boundingBox: unknown } | null,
    faces: Array<{ id: string; mediaItemId: string; boundingBox: unknown; confidence?: number | null }>,
  ): { faceId: string; mediaItemId: string; boundingBox: unknown } | null {
    if (coverFace) {
      return {
        faceId: coverFace.id,
        mediaItemId: coverFace.mediaItemId,
        boundingBox: coverFace.boundingBox,
      };
    }
    // Fallback: pick the first face (caller must provide them sorted by relevance)
    const fallback = faces[0];
    if (!fallback) return null;
    return {
      faceId: fallback.id,
      mediaItemId: fallback.mediaItemId,
      boundingBox: fallback.boundingBox,
    };
  }

  private async assertFacesInCircle(
    faceIds: string[],
    circleId: string,
  ): Promise<void> {
    const found = await this.prisma.face.findMany({
      where: { id: { in: faceIds }, circleId },
      select: { id: true },
    });

    if (found.length !== faceIds.length) {
      const foundSet = new Set(found.map((f) => f.id));
      const missing = faceIds.filter((id) => !foundSet.has(id));
      throw new NotFoundException(
        `Faces not found in circle: ${missing.join(', ')}`,
      );
    }
  }
}
