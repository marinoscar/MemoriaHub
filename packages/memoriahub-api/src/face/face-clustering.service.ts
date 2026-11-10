// =============================================================================
// FaceClusteringService
// =============================================================================
//
// Groups unknown (personId = null) faces in a circle into provisional Person
// records using greedy union-find clustering by cosine similarity.
//
// Algorithm:
//   1. Load all faces in the circle with personId = null and non-empty embedding.
//   2. Compute cosine similarity for every pair.
//   3. Union pairs with similarity >= clusterThreshold (path-compressed union-find).
//   4. For each cluster with size >= clusterMinSize, create a Person and assign
//      the faces to it (manuallyAssigned = false).
//   5. Singletons stay with personId = null.
//
// Idempotency: only processes faces with personId IS NULL, so re-running will
// not re-cluster already-assigned faces.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FaceMatchingService } from './face-matching.service';

@Injectable()
export class FaceClusteringService {
  private readonly logger = new Logger(FaceClusteringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly matchingService: FaceMatchingService,
  ) {}

  /**
   * Cluster unknown faces in a circle into provisional Person records.
   *
   * @param circleId - Target circle
   * @param addedById - User ID to record as creator of new Person records
   * @returns Number of Person clusters created and total faces assigned
   */
  async clusterUnknownFaces(
    circleId: string,
    addedById: string,
  ): Promise<{ clustersCreated: number; facesAssigned: number }> {
    // 1. Load all unassigned faces with embeddings
    const faces = await this.prisma.face.findMany({
      where: {
        circleId,
        personId: null,
        // Never re-surface archived (hidden) faces into a new Person cluster.
        hiddenAt: null,
      },
      select: { id: true, embedding: true },
    });

    const eligible = faces.filter((f) => f.embedding && f.embedding.length > 0);

    this.logger.log(
      `clusterUnknownFaces: ${eligible.length} eligible faces (of ${faces.length} unassigned) in circle ${circleId}`,
    );

    if (eligible.length === 0) {
      return { clustersCreated: 0, facesAssigned: 0 };
    }

    const n = eligible.length;
    const threshold = this.matchingService.clusterThreshold;

    // 2. Path-compressed union-find
    const parent = Array.from({ length: n }, (_, i) => i);

    function find(x: number): number {
      if (parent[x] !== x) parent[x] = find(parent[x]);
      return parent[x];
    }

    function union(x: number, y: number): void {
      const rx = find(x);
      const ry = find(y);
      if (rx !== ry) parent[rx] = ry;
    }

    // 3. Union pairs with similarity >= threshold (O(n^2) over embeddings)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sim = this.matchingService.cosineSimilarity(
          eligible[i].embedding,
          eligible[j].embedding,
        );
        if (sim >= threshold) {
          union(i, j);
        }
      }
    }

    // 4. Group by root
    const clusterMap = new Map<number, string[]>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      const members = clusterMap.get(root) ?? [];
      members.push(eligible[i].id);
      clusterMap.set(root, members);
    }

    const minSize = this.matchingService.clusterMinSize;
    let clustersCreated = 0;
    let facesAssigned = 0;

    // 5. Create Person for each cluster meeting the minimum size
    for (const [, faceIds] of clusterMap) {
      if (faceIds.length < minSize) continue;

      const person = await this.prisma.person.create({
        data: {
          circleId,
          addedById,
          name: null, // unlabeled cluster
        },
      });

      await this.prisma.face.updateMany({
        where: { id: { in: faceIds } },
        data: { personId: person.id, manuallyAssigned: false },
      });

      clustersCreated++;
      facesAssigned += faceIds.length;

      this.logger.debug(
        `Created provisional Person ${person.id} with ${faceIds.length} face(s)`,
      );
    }

    this.logger.log(
      `clusterUnknownFaces: created ${clustersCreated} person cluster(s), assigned ${facesAssigned} face(s) in circle ${circleId}`,
    );

    return { clustersCreated, facesAssigned };
  }
}
