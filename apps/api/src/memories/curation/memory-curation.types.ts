// =============================================================================
// Memories — shared curation types (epic #300, issue #303)
// =============================================================================
//
// The vocabulary every curator speaks. Kept in its own module (rather than
// inside MemoryCurationService) so a curator can import the shapes without
// importing the service, and so the pure scoring/selection helpers stay unit
// testable with plain object literals and no Nest module graph.
// =============================================================================

import { MediaType, MemoryType } from '@prisma/client';

/**
 * One media item considered for inclusion in a memory, hydrated with exactly
 * the signals the scorer needs and nothing else.
 *
 * Deliberately flat and tiny: a curation pass over a large circle holds up to
 * `maxCandidates` of these at once, so every field here is paid for per
 * candidate. `capturedAt` is non-nullable because the curation base filter
 * (`capturedAt IS NOT NULL`) makes it so — a candidate can never reach this
 * type with a null capture date.
 */
export interface MemoryCandidate {
  id: string;
  capturedAt: Date;
  type: MediaType;
  durationMs: number | null;
  favorite: boolean;
  sharpnessScore: number | null;
  burstGroupId: string | null;
  duplicateGroupId: string | null;
  /** Has an AI description or at least one AI-applied tag. */
  hasAiContent: boolean;
  /** Carries a face assigned to a live, non-hidden Person marked `favorite`. */
  hasFavoritePersonFace: boolean;
}

/** A candidate plus its computed scores. */
export interface ScoredCandidate extends MemoryCandidate {
  /**
   * The pure quality score from the epic's formula. This is what gets
   * persisted to `MemoryItem.score` — an audit of why the item was picked,
   * independent of any selection-time preference.
   */
  score: number;
  /**
   * The score actually used for ranking during selection. Equal to `score`
   * except for long/unknown-duration videos, which carry a preference penalty
   * (see LONG_VIDEO_PENALTY). Never persisted: it is an ordering device, not a
   * property of the item.
   */
  selectionScore: number;
}

/** One chosen item, in final chronological order. */
export interface CuratedItem {
  mediaItemId: string;
  position: number;
  score: number;
}

/** The full output of a curation pass over one candidate set. */
export interface CuratedSelection {
  /** Chronologically ascending, `position` 0..n-1. */
  items: CuratedItem[];
  /** Highest-scored NON-video item, or null when the selection is all video. */
  coverMediaItemId: string | null;
  /** Earliest / latest `capturedAt` across `items`; null when empty. */
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Candidates seen before collapse/selection — useful for logging. */
  candidateCount: number;
  /** True when the candidate scan hit its hard cap and stopped early. */
  truncated: boolean;
}

/** Input to the idempotent `upsertMemory` helper every curator funnels through. */
export interface UpsertMemoryInput {
  circleId: string;
  type: MemoryType;
  /** Per-type period identity — see the MemoryType enum comment in schema.prisma. */
  periodKey: string;
  /** Per-type subject identity. NEVER null — `''` when the type does not use it. */
  subjectKey?: string;
  personId?: string | null;
  /** Template-derived title/subtitle. Used verbatim on create, and on a material refresh. */
  title: string;
  subtitle?: string | null;
  selection: CuratedSelection;
  meta?: Record<string, unknown> | null;
  expiresAt?: Date | null;
}

/** Outcome of one `upsertMemory` call. */
export interface UpsertMemoryResult {
  /** The live row, or null when the upsert was refused by the tombstone. */
  memoryId: string | null;
  created: boolean;
  /**
   * True when this call materially changed what the memory contains: a fresh
   * create, or a refresh whose membership moved by at least
   * MATERIAL_CHANGE_THRESHOLD (Jaccard distance on media-item id sets).
   *
   * Consumed by #311's notification/digest producers to answer "is there
   * anything new worth telling the circle about?" without re-diffing.
   */
  materiallyChanged: boolean;
  /** True when an existing tombstoned (user-deleted) row refused the upsert. */
  skippedTombstone: boolean;
}
