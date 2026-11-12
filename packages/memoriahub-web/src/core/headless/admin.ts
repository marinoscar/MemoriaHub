// =============================================================================
// The admin port: what an admin page asks its host for
// =============================================================================
//
// An admin page of a domain slice (the tag vocabulary, the Tagging and Workflows
// settings) is built from three things the platform owns and a host-neutral
// package cannot import: a data table, the console's page header and the
// deployment settings document. The host supplies them through `host.admin`;
// the types below are the structural subset the pages use, so the web edition
// binds the platform's `DataTable`, its `AdminPageHeader` and `useSystemSettings`
// (`apps/web/src/platform-memoriahub/admin.tsx`) and a fork binds its own.
// =============================================================================

import type { ReactNode } from 'react';

import { useMemoriahubHost } from './host.js';

/**
 * How a data-table column ranks: `primary` and `secondary` columns show in the
 * table and on a phone's card, `detail` columns only in the expanded row.
 *
 * @stability experimental
 */
export type MemoriahubDataTableColumnPriority = 'primary' | 'secondary' | 'detail';

/**
 * One column of a {@link MemoriahubDataTableComponent}.
 *
 * @stability experimental
 */
export interface MemoriahubDataTableColumn<Row> {
  /** Stable id (the column picker and the CSV header key on it). */
  id: string;
  /** Header text, also the label on a phone's card. */
  label: string;
  /** The cell's visual form; absent means the table renders {@link MemoriahubDataTableColumn.value}. */
  render?: (row: Row) => ReactNode;
  /** The scalar sorting, filtering and CSV export operate on. */
  value?: (row: Row) => string | number | null;
  /** Cell alignment. */
  align?: 'left' | 'center' | 'right';
  /** Which layouts show the column. */
  priority: MemoriahubDataTableColumnPriority;
  /** Long values are clipped with an ellipsis and reveal the full text on hover or focus. */
  truncate?: boolean;
  /** A fixed width in pixels. */
  width?: number;
  /** The narrowest width in pixels. */
  minWidth?: number;
  /** False keeps the column out of the user's column picker (it always shows). */
  hideable?: boolean;
  /** Share of the free width. */
  flex?: number;
}

/**
 * The confirmation a destructive row action asks for.
 *
 * @stability experimental
 */
export interface MemoriahubDataTableConfirm<Row> {
  /** The dialog title. */
  title: string;
  /** The body, from the row. */
  description?: string | ((row: Row) => string);
  /** The confirm button's label. */
  confirmLabel?: string;
}

/**
 * A per-row action.
 *
 * @stability experimental
 */
export interface MemoriahubDataTableRowAction<Row> {
  /** Stable id. */
  id: string;
  /** The visible label (also the accessible name). */
  label: string;
  /** A leading glyph. */
  icon?: ReactNode;
  /** Runs the action. */
  onClick: (row: Row) => void;
  /** Per-row disabled state. */
  disabled?: (row: Row) => boolean;
  /** Styles the action as destructive. */
  destructive?: boolean;
  /** Ask for a confirmation before `onClick`. */
  confirm?: boolean | MemoriahubDataTableConfirm<Row>;
}

/**
 * Controlled pagination (zero-based `page`).
 *
 * @stability experimental
 */
export interface MemoriahubDataTablePagination {
  /** The zero-based page. */
  page: number;
  /** Rows per page. */
  pageSize: number;
  /** Total rows across pages. */
  total: number;
  /** Called with the next page and size. */
  onPaginationChange: (next: { page: number; pageSize: number }) => void;
  /** The page sizes offered. */
  pageSizeOptions?: number[];
}

/**
 * The props a page gives the host's data table.
 *
 * @stability experimental
 */
export interface MemoriahubDataTableProps<Row> {
  /** The column declarations. */
  columns: MemoriahubDataTableColumn<Row>[];
  /** The rows of the current page; the table never slices them. */
  rows: Row[];
  /** A row's stable id. */
  rowId: (row: Row) => string;
  /** Persists the user's column layout under this id. */
  tableId?: string;
  /** The table's accessible name. */
  ariaLabel?: string;
  /** Row density. */
  density?: 'compact' | 'standard' | 'comfortable';
  /** True while rows load. */
  loading?: boolean;
  /** Rendered when there are no rows. */
  emptyState?: ReactNode;
  /** Controlled pagination. */
  pagination?: MemoriahubDataTablePagination;
  /** Per-row actions. */
  rowActions?: MemoriahubDataTableRowAction<Row>[];
  /** Turns the generic CSV export on, naming the file. */
  csvExport?: { filename?: string };
  /** Turns the generic CSV export off (a page with its own round trip). */
  disableExport?: boolean;
}

/**
 * The host's data table: responsive (a card list on a phone), paginated, with
 * row actions and an optional CSV export.
 *
 * @stability experimental
 * @extensionPoint host
 */
export type MemoriahubDataTableComponent = <Row>(props: MemoriahubDataTableProps<Row>) => ReactNode;

/**
 * Props of the host's admin page header.
 *
 * @stability experimental
 */
export interface MemoriahubAdminPageHeaderProps {
  /** Rendered as the page's single `<h1>`. */
  title: ReactNode;
  /** A leading glyph. */
  icon?: ReactNode;
  /** A status chip rendered beside the title, outside the `<h1>`. */
  titleAdornment?: ReactNode;
  /** The paragraph under the title. */
  description?: ReactNode;
  /** Where the back link points; defaults to the settings hub. */
  backTo?: string;
  /** Trailing controls. */
  actions?: ReactNode;
}

/**
 * The host's admin console header: the back link (hidden below the small
 * breakpoint, where the shell's drill-down arrow goes to the same place), the
 * title row and the description.
 *
 * @stability experimental
 * @extensionPoint host
 */
export type MemoriahubAdminPageHeaderComponent = (props: MemoriahubAdminPageHeaderProps) => ReactNode;

/**
 * The stored-secret presentation a {@link MemoriahubSecretFieldProps} shows.
 *
 * @stability experimental
 */
export interface MemoriahubSavedSecret {
  /** A masked hint of the stored secret (for example its last four characters). */
  hint: string;
  /** When the secret was last changed (ISO 8601). */
  updatedAt?: string | null;
}

/**
 * The props of the host's write-only secret input.
 *
 * @stability experimental
 */
export interface MemoriahubSecretFieldProps {
  /** The field's label. */
  label: string;
  /** The typed replacement; the empty string keeps the stored secret. */
  value: string;
  /** Receives the new value on every keystroke. */
  onChange: (value: string) => void;
  /** The stored secret's presentation, or `null` when nothing is stored. */
  saved?: MemoriahubSavedSecret | null;
  /** The helper text when nothing is stored. */
  emptyHelp?: string;
  /** What the secret is called in the helper text. */
  noun?: string;
  /** Disables the input. */
  disabled?: boolean;
  /** An error message shown instead of the helper text. */
  error?: string | null;
  /** The input's `name`. */
  name?: string;
  /** The element id. */
  id?: string;
  /** Styles for the field's root, as an MUI `sx` object (the host passes them on). */
  sx?: Record<string, unknown>;
}

/**
 * The host's write-only secret input: it never shows the stored secret, only a
 * masked hint, and an empty value keeps what is stored.
 *
 * @stability experimental
 * @extensionPoint host
 */
export type MemoriahubSecretFieldComponent = (props: MemoriahubSecretFieldProps) => ReactNode;

/**
 * The tagging half of the deployment settings (`autoTagging.video.*`,
 * `ai.features.transcription`).
 *
 * @stability experimental
 */
export interface MemoriahubTaggingSettings {
  /** `autoTagging`: the video sub-feature. */
  autoTagging?: {
    video?: {
      enabled?: boolean;
      maxFrames?: number;
      sampleIntervalSeconds?: number;
      transcription?: { enabled?: boolean; leadSeconds?: number };
    };
  };
  /** `ai.features`: the speech-to-text selection video tagging reads. */
  ai?: { features?: { transcription?: { provider: string; model: string } | null } };
}

/**
 * The workflows half of the deployment settings (`workflows.*`).
 *
 * @stability experimental
 */
export interface MemoriahubWorkflowsSettings {
  /** `workflows`: the engine limits and the unattended-trigger switches. */
  workflows?: {
    maxItemsPerRun?: number;
    batchSize?: number;
    maxConcurrentRuns?: number;
    requirePreview?: boolean;
    allowHardDelete?: boolean;
    maxWorkflowsPerCircle?: number;
    previewTtlHours?: number;
    runHistoryRetentionDays?: number;
    triggers?: { onEnrichment?: boolean; scheduled?: boolean };
    scheduleMinIntervalMinutes?: number;
  };
}

/**
 * The memories half of the deployment settings (`memories.*`).
 *
 * @stability experimental
 */
export interface MemoriahubMemoriesSettings {
  /** `memories`: generation, per-type curators and the email digest; every key is absent until first saved. */
  memories?: {
    generation?: { intervalHours?: number };
    maxItemsPerMemory?: number;
    aiTitles?: { enabled?: boolean };
    onThisDay?: { enabled?: boolean; lookbackYears?: number; minItems?: number };
    trips?: {
      enabled?: boolean;
      minDays?: number;
      minItems?: number;
      minDistanceKm?: number;
      lookbackMonths?: number;
    };
    people?: { enabled?: boolean; favoritesOnly?: boolean; minItems?: number };
    themes?: { enabled?: boolean; minItems?: number; maxPerPeriod?: number };
    seasonal?: { enabled?: boolean; minItems?: number };
    yearInReview?: { enabled?: boolean; minItems?: number };
    digest?: {
      enabled?: boolean;
      frequency?: 'off' | 'daily' | 'weekly' | 'monthly';
      sendHourUtc?: number;
      imageTokenTtlDays?: number;
    };
  };
}

/**
 * The face half of the deployment settings (`face.video.*`, `face.autoArchive.*`).
 *
 * @stability experimental
 */
export interface MemoriahubFaceSettings {
  /** `face`: the video sub-feature and the auto-archive match threshold. */
  face?: {
    video?: { enabled?: boolean; sampleIntervalSeconds?: number; maxFramesPerVideo?: number };
    autoArchive?: { matchThreshold?: number };
  };
}

/**
 * The review-queue half of the deployment settings: the confidence floors the
 * burst, duplicate and location-suggestion pages preselect for their bulk actions.
 *
 * @stability experimental
 */
export interface MemoriahubReviewSettings {
  /** `burst`: the auto-resolve threshold (percent). */
  burst?: { autoResolveThreshold?: number };
  /** `dedup`: the auto-resolve threshold (percent). */
  dedup?: { autoResolveThreshold?: number };
  /** `locationInference`: the bulk-accept threshold (percent). */
  locationInference?: { bulkAcceptThreshold?: number };
}

/**
 * The picture-enhancement half of the deployment settings (`pictureEnhancement.*`).
 *
 * @stability experimental
 */
export interface MemoriahubEnhancementSettings {
  /** `pictureEnhancement`: the defaults and the replace policy; every key is absent until first saved. */
  pictureEnhancement?: {
    defaultQuality?: 'low' | 'medium' | 'high';
    defaultStrength?: 'subtle' | 'balanced' | 'strong';
    stampExif?: boolean;
    allowReplace?: boolean;
    blockReplaceOnDownscale?: boolean;
    maxInputMegapixels?: number;
    retentionHours?: number;
    maxBatchSize?: number;
  };
}

/**
 * The deployment settings document as the domain admin pages read it: the
 * namespaces they edit, typed, and the version the host sends back as `If-Match`.
 *
 * @stability experimental
 */
export interface MemoriahubSystemSettings
  extends MemoriahubTaggingSettings,
    MemoriahubWorkflowsSettings,
    MemoriahubMemoriesSettings,
    MemoriahubFaceSettings,
    MemoriahubReviewSettings,
    MemoriahubEnhancementSettings {
  /** The global feature flags. */
  features: Record<string, boolean>;
  /** The document version. */
  version: number;
}

/**
 * The deployment settings state a page reads and writes.
 *
 * @stability experimental
 */
export interface MemoriahubSystemSettingsState {
  /** The document, `null` while loading or when the read failed. */
  settings: MemoriahubSystemSettings | null;
  /** True while the document loads. */
  isLoading: boolean;
  /** The failure message, `null` when none. */
  error: string | null;
  /** True while a write is in flight. */
  isSaving: boolean;
  /** Merge-patches the document; rejects when the write is refused. */
  updateSettings: (updates: Partial<MemoriahubSystemSettings>) => Promise<void>;
  /** Reloads the document. */
  refresh: () => Promise<void>;
}

/**
 * One AI provider as the Memories admin page lists it.
 *
 * @stability experimental
 */
export interface MemoriahubAiProvider {
  /** The provider id. */
  provider: string;
  /** True when a credential is stored. */
  configured: boolean;
  /** True when the credential is switched on. */
  enabled: boolean;
}

/**
 * The AI settings the Memories admin page reads: the providers and the model chosen for memory titles.
 *
 * @stability experimental
 */
export interface MemoriahubAiSettings {
  /** The providers with a stored credential. */
  providers?: MemoriahubAiProvider[];
  /** Every provider the server can talk to. */
  knownProviders?: MemoriahubAiProvider[];
  /** The feature selections. */
  features?: { memories?: { provider: string | null; model: string | null } | null };
}

/**
 * The AI settings state a page reads and writes (the host's AI settings hook).
 *
 * @stability experimental
 */
export interface MemoriahubAiSettingsState {
  /** The settings, `null` until the first load. */
  settings: MemoriahubAiSettings | null;
  /** Loads (or reloads) the settings. */
  fetchSettings: () => Promise<void>;
  /** The chat models of a provider. */
  getModels: (provider: string) => Promise<string[]>;
  /** Selects the model that writes memory titles; both `null` clears the selection. */
  saveMemoriesFeature: (provider: string | null, model: string | null) => Promise<void>;
}

/**
 * Whether outbound email is usable (the fields of the platform email settings the digest section reads).
 *
 * @stability experimental
 */
export interface MemoriahubEmailReadiness {
  /** The selected transport id, or `null`. */
  provider: string | null;
  /** Master switch: nothing is sent while false. */
  enabled: boolean;
}

/**
 * What the host supplies to the domain admin pages.
 *
 * @stability experimental
 * @extensionPoint host
 */
export interface MemoriahubAdminPort {
  /** The data table. */
  DataTable: MemoriahubDataTableComponent;
  /** The admin console page header. */
  AdminPageHeader: MemoriahubAdminPageHeaderComponent;
  /** The write-only secret input (provider API keys). */
  SecretField: MemoriahubSecretFieldComponent;
  /**
   * A React hook (the same function for the life of the host, following the
   * rules of hooks) over the deployment settings document.
   */
  useSystemSettings(): MemoriahubSystemSettingsState;
  /**
   * A React hook (the same function for the life of the host) over the AI settings;
   * the Memories page picks the model that writes memory titles with it.
   */
  useAiSettings(): MemoriahubAiSettingsState;
  /** Whether outbound email is usable, for the Memories digest warning. */
  getEmailReadiness(): Promise<MemoriahubEmailReadiness>;
}

/**
 * Thrown when an admin page renders in a host that supplies no admin port.
 *
 * @stability experimental
 */
export class MemoriahubAdminPortMissingError extends Error {
  /** Names the missing port so a stack trace is self-explanatory. */
  constructor() {
    super(
      'The MemoriahubWebHost has no `admin` port: an admin page of @marinoscar/memoriahub-web needs a data table, ' +
        'an admin page header and a system-settings hook from its host (the web edition binds them in apps/web/src/platform-memoriahub/admin.tsx).',
    );
    this.name = 'MemoriahubAdminPortMissingError';
  }
}

/**
 * The host's admin port.
 *
 * @returns the port.
 * @throws {@link MemoriahubAdminPortMissingError} when the host supplies none.
 *
 * @stability experimental
 */
export function useMemoriahubAdmin(): MemoriahubAdminPort {
  const { admin } = useMemoriahubHost();
  if (!admin) throw new MemoriahubAdminPortMissingError();
  return admin;
}
