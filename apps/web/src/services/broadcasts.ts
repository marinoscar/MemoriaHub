/**
 * The admin broadcast API, as the web app sees it. Epic #481, issue #488
 * (ported from the reference implementation).
 *
 * The types mirror `apps/api/src/notifications/broadcasts/dto/` field for
 * field (`broadcast-response.dto.ts`, `create-broadcast.dto.ts`,
 * `broadcast-list-query.dto.ts`), and the limits mirror
 * `create-broadcast.dto.ts` / `broadcast-constants.ts`.
 * The limits are restated here because there is no shared type surface between
 * the workspaces: the composer's counters must promise exactly what the API's
 * validator accepts.
 */

import { api } from './api';

// =============================================================================
// Enumerations and limits
// =============================================================================

export const BROADCAST_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'canceled',
  'failed',
] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

/** Delivery channels, in the order the composer draws them. */
export const BROADCAST_CHANNELS = ['inbox', 'push', 'email'] as const;
export type BroadcastChannel = (typeof BROADCAST_CHANNELS)[number];

export const BROADCAST_TITLE_MAX = 120;
export const BROADCAST_BODY_MAX = 2_000;
export const BROADCAST_LINK_MAX = 500;
export const BROADCAST_CTA_LABEL_MAX = 40;

/**
 * `BROADCAST_STATUS_RECHECK_INTERVAL` in `broadcast-constants.ts`: a chunk
 * re-checks status and commits its cursor every this many recipients. So it
 * bounds both how many more recipients a cancel of a `sending` broadcast may
 * still reach, and how many a resume may send to twice. Named in the
 * confirmations, because "some may still be sent" reads like the cancel failed.
 */
export const BROADCAST_RECHECK_INTERVAL = 25;

const CHANNEL_LABELS: Record<string, string> = {
  inbox: 'Inbox',
  push: 'Push',
  email: 'Email',
};

/** A channel key → what an administrator calls it. */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

// =============================================================================
// Shapes
// =============================================================================

/** A user reference as the API embeds it (never a bare id). */
export interface BroadcastUserRef {
  id: string;
  email: string;
  displayName: string | null;
}

export interface Broadcast {
  id: string;
  title: string;
  body: string;
  link: string | null;
  ctaLabel: string | null;
  critical: boolean;
  channels: BroadcastChannel[];
  status: BroadcastStatus;
  scheduledFor: string | null;
  /** Stamped when the fan-out claims the row: the instant the audience froze. */
  audienceCutoff: string | null;
  /** `null` until the audience is frozen and counted — never treat it as 0. */
  recipientCount: number | null;
  processedCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: BroadcastUserRef | null;
  canceledBy: BroadcastUserRef | null;
}

export interface BroadcastListResponse {
  items: Broadcast[];
  meta: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

export interface BroadcastAudience {
  activeUsers: number;
}

export interface BroadcastTestResult {
  notificationType: 'admin_broadcast' | 'admin_broadcast_critical';
  channels: BroadcastChannel[];
  sentToUserId: string;
  /** `null` when email was not selected. */
  email: { success: boolean; error: string | null } | null;
}

export interface CreateBroadcastRequest {
  title: string;
  body: string;
  link?: string;
  ctaLabel?: string;
  critical: boolean;
  channels: BroadcastChannel[];
  /** ISO-8601 instant; omitted = send now. */
  scheduledFor?: string;
}

export interface BroadcastListParams {
  page?: number;
  pageSize?: number;
  status?: BroadcastStatus;
}

const BASE = '/admin/broadcasts';

// =============================================================================
// Calls
// =============================================================================

export function getBroadcasts(params: BroadcastListParams = {}): Promise<BroadcastListResponse> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  if (params.status) query.set('status', params.status);
  const suffix = query.toString();
  return api.get<BroadcastListResponse>(`${BASE}${suffix ? `?${suffix}` : ''}`);
}

export function getBroadcast(id: string): Promise<Broadcast> {
  return api.get<Broadcast>(`${BASE}/${id}`);
}

export function createBroadcast(body: CreateBroadcastRequest): Promise<Broadcast> {
  return api.post<Broadcast>(BASE, body);
}

export function cancelBroadcast(id: string): Promise<Broadcast> {
  return api.post<Broadcast>(`${BASE}/${id}/cancel`);
}

export function resumeBroadcast(id: string): Promise<Broadcast> {
  return api.post<Broadcast>(`${BASE}/${id}/resume`);
}

export async function deleteBroadcast(id: string): Promise<void> {
  await api.delete<void>(`${BASE}/${id}`);
}

/** Send this composition to the CALLING admin only. Stores nothing. */
export function sendTestBroadcast(body: CreateBroadcastRequest): Promise<BroadcastTestResult> {
  return api.post<BroadcastTestResult>(`${BASE}/test`, body);
}

/** How many active users a broadcast created right now would reach (an estimate). */
export function getBroadcastAudience(): Promise<BroadcastAudience> {
  return api.get<BroadcastAudience>(`${BASE}/audience`);
}

// =============================================================================
// Predicates — mirrors of the API's own 409s
// =============================================================================

export function isBroadcastCancelable(broadcast: Pick<Broadcast, 'status'>): boolean {
  return (
    broadcast.status === 'scheduled' ||
    broadcast.status === 'sending' ||
    broadcast.status === 'failed'
  );
}

export function isBroadcastResumable(broadcast: Pick<Broadcast, 'status'>): boolean {
  return broadcast.status === 'failed';
}

export function isBroadcastDeletable(broadcast: Pick<Broadcast, 'status'>): boolean {
  return broadcast.status !== 'sending';
}

// =============================================================================
// `datetime-local` ⇄ ISO-8601
// =============================================================================
//
// A `datetime-local` value is LOCAL wall-clock with no zone; the API takes an
// instant. These two are the whole bridge, unit-tested across DST.

/** A `datetime-local` value → the ISO instant; `null` for empty/unparseable. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  // `YYYY-MM-DDTHH:mm` is specified to parse as LOCAL time.
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** An ISO instant → the `datetime-local` value that displays it (local getters). */
export function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const year = String(date.getFullYear()).padStart(4, '0');
  return `${year}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}
