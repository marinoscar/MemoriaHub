import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../../prisma/prisma.service';
import { DEFAULT_FACE_VECTOR_BACKEND } from '@marinoscar/memoriahub-api/face';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, errorMessage, fail, pass, skip, warn } from '../outcome';

// Ported from `DoctorService.checkFacePgvector` (key `face.pgvector`).
// READ-ONLY: two catalog SELECTs.
//
// When FACE_VECTOR_BACKEND resolves to 'pgvector' (the default) face matching
// relies on the trigger-maintained faces.embedding_vec column and its three
// HNSW indexes. Skipped when the backend is 'app'.

const ROLLBACK_HINT =
  'Run migrations (npx prisma migrate deploy) to add the face pgvector column/indexes, ' +
  'or set FACE_VECTOR_BACKEND=app to roll back to in-app cosine matching.';

export interface FacePgvectorFacts {
  columnPresent: boolean;
  mainIndexPresent: boolean;
  archiveIndexPresent: boolean;
  assignedIndexPresent: boolean;
}

export function decideFacePgvector(backend: string, facts: FacePgvectorFacts): DoctorCheckOutcome {
  if (backend === 'app') {
    return skip('FACE_VECTOR_BACKEND=app; face matching uses in-app cosine (pgvector column not required).');
  }
  if (!facts.columnPresent || !facts.mainIndexPresent) {
    return warn(
      !facts.columnPresent
        ? 'FACE_VECTOR_BACKEND=pgvector but faces.embedding_vec column is missing.'
        : 'FACE_VECTOR_BACKEND=pgvector but faces_embedding_vec_hnsw_idx index is missing.',
      ROLLBACK_HINT,
    );
  }
  if (!facts.archiveIndexPresent) {
    return warn(
      'faces_embedding_vec_archive_hnsw_idx (partial archive index) is missing; ' +
        'face-auto-archive KNN falls back to the main index and is slower.',
      'Run migrations (npx prisma migrate deploy) to add the partial archive index.',
    );
  }
  if (!facts.assignedIndexPresent) {
    return warn(
      'faces_embedding_vec_assigned_hnsw_idx (partial assigned-set index) is missing; ' +
        'person-match KNN falls back to the main index and can be starved by unassigned faces after bulk imports.',
      'Run migrations (npx prisma migrate deploy) to add the partial assigned-set index.',
    );
  }
  return pass('faces.embedding_vec column and all three HNSW indexes present.');
}

@Injectable()
export class FacePgvectorDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('face', 'pgvector');
  readonly category = 'face';
  readonly label = 'Face pgvector index';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;
  readonly dependsOn = ['db.connection'] as const;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const backend = process.env['FACE_VECTOR_BACKEND'] ?? DEFAULT_FACE_VECTOR_BACKEND;
    if (backend === 'app') {
      return decideFacePgvector(backend, {
        columnPresent: false,
        mainIndexPresent: false,
        archiveIndexPresent: false,
        assignedIndexPresent: false,
      });
    }

    try {
      const [colRows, idxRows] = await Promise.all([
        this.prisma.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok FROM information_schema.columns
          WHERE table_name = 'faces' AND column_name = 'embedding_vec'
        `,
        this.prisma.$queryRaw<Array<{ indexname: string }>>`
          SELECT indexname FROM pg_indexes
          WHERE tablename = 'faces'
            AND indexname IN (
              'faces_embedding_vec_hnsw_idx',
              'faces_embedding_vec_archive_hnsw_idx',
              'faces_embedding_vec_assigned_hnsw_idx'
            )
        `,
      ]);
      const names = new Set(idxRows.map((r) => r.indexname));
      return decideFacePgvector(backend, {
        columnPresent: colRows.length > 0,
        mainIndexPresent: names.has('faces_embedding_vec_hnsw_idx'),
        archiveIndexPresent: names.has('faces_embedding_vec_archive_hnsw_idx'),
        assignedIndexPresent: names.has('faces_embedding_vec_assigned_hnsw_idx'),
      });
    } catch (err) {
      return fail(errorMessage(err), ROLLBACK_HINT);
    }
  }
}
