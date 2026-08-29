import type { SvgIconComponent } from '@mui/icons-material';
import DeleteSweep from '@mui/icons-material/DeleteSweep';
import Movie from '@mui/icons-material/Movie';
import PhotoAlbum from '@mui/icons-material/PhotoAlbum';
import Label from '@mui/icons-material/Label';
import ContentCopy from '@mui/icons-material/ContentCopy';
import type { WorkflowDefinition, WorkflowTriggerType } from '../types/workflows';

// ---------------------------------------------------------------------------
// Ready-made workflow templates surfaced in the templates gallery. These are
// pure client-side constants; selecting one pre-fills the builder (see the
// template hydration contract in WorkflowBuilderPage). Each `definition` is a
// full, valid backend definition (version 1, subject 'media_item') with action
// params as TOP-LEVEL siblings of `type`.
// ---------------------------------------------------------------------------

export interface WorkflowTemplate {
  id: string;
  name: string;
  title: string;
  description: string;
  plainLanguage: string;
  icon: SvgIconComponent;
  suggestedTrigger: WorkflowTriggerType;
  suggestedCron?: string | null;
  definition: WorkflowDefinition;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'clean-up-screenshots',
    name: 'Clean up screenshots',
    title: 'Clean up screenshots',
    description:
      'Automatically move screenshots to Trash as new media arrives.',
    plainLanguage:
      "When new media is enriched, if the filename contains 'screenshot' or it's a PNG with no camera and no date, move it to Trash.",
    icon: DeleteSweep,
    suggestedTrigger: 'on_media_enriched',
    definition: {
      version: 1,
      subject: 'media_item',
      match: 'any',
      conditions: [
        { field: 'filename', op: 'contains', value: 'screenshot' },
        {
          match: 'all',
          conditions: [
            { field: 'mimeType', op: 'equals', value: 'image/png' },
            { field: 'missingCamera', op: 'is', value: true },
            { field: 'missingCapturedAt', op: 'is', value: true },
          ],
        },
      ],
      actions: [{ type: 'move_to_trash' }],
    },
  },
  {
    id: 'archive-social-videos',
    name: 'Archive social-media videos',
    title: 'Archive social-media videos',
    description:
      'Keep social-media re-shares out of your main library by archiving them nightly.',
    plainLanguage:
      'Every night, if a video came from social media, archive it.',
    icon: Movie,
    suggestedTrigger: 'scheduled',
    suggestedCron: '0 3 * * *',
    definition: {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [{ field: 'socialMediaSource', op: 'is_set' }],
      actions: [{ type: 'archive' }],
    },
  },
  {
    // Epic #452's headline use case, made discoverable: "for videos captured
    // between date A and date B, re-run AI tagging".
    id: 'retag-videos-in-range',
    name: 'Re-tag videos from a date range',
    title: 'Re-tag videos from a date range',
    description:
      'Give a batch of videos AI tags and a written description, so they turn up in search.',
    plainLanguage:
      'If a video was captured within a date range, re-run AI tagging on it.',
    icon: Movie,
    suggestedTrigger: 'manual',
    definition: {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [
        { field: 'mediaType', op: 'equals', value: 'video' },
        {
          field: 'capturedAt',
          op: 'between',
          value: ['2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z'],
        },
      ],
      actions: [{ type: 'rerun_ai_tagging' }],
    },
  },
  {
    id: 'trip-album',
    name: 'Album from a trip',
    title: 'Album from a trip',
    description:
      'Gather photos from a date range and country into a named album.',
    plainLanguage:
      'If a photo was captured within a date range and in a chosen country, add it to an album.',
    icon: PhotoAlbum,
    suggestedTrigger: 'manual',
    definition: {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [
        {
          field: 'capturedAt',
          op: 'between',
          value: { from: '2025-06-01', to: '2025-06-14' },
        },
        { field: 'country', op: 'equals', value: 'Italy' },
      ],
      actions: [{ type: 'add_to_album', createAlbumNamed: 'Italy 2025' }],
    },
  },
  {
    id: 'tag-whatsapp',
    name: 'Tag WhatsApp images',
    title: 'Tag WhatsApp images',
    description:
      'Label incoming WhatsApp-style images so you can find or filter them later.',
    plainLanguage:
      "If the filename starts with 'IMG-' and there's no camera info, add a WhatsApp tag.",
    icon: Label,
    suggestedTrigger: 'on_media_enriched',
    definition: {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [
        { field: 'filename', op: 'starts_with', value: 'IMG-' },
        { field: 'missingCamera', op: 'is', value: true },
      ],
      actions: [{ type: 'add_tags', names: ['WhatsApp'] }],
    },
  },
  {
    id: 'clean-up-duplicates',
    name: 'Clean up duplicates',
    title: 'Clean up duplicates',
    description:
      'Weekly, keep the best copy in high-confidence duplicate groups and trash the rest.',
    plainLanguage:
      'Weekly, for photos in a pending duplicate group with confidence ≥ 0.9, keep the best copy and trash the rest.',
    icon: ContentCopy,
    suggestedTrigger: 'scheduled',
    suggestedCron: '0 4 * * 0',
    definition: {
      version: 1,
      subject: 'media_item',
      match: 'all',
      conditions: [
        { field: 'inPendingDuplicateGroup', op: 'is', value: true },
        { field: 'duplicateGroupConfidence', op: 'gte', value: 0.9 },
      ],
      actions: [{ type: 'resolve_duplicate_group', action: 'trash' }],
    },
  },
];

/** Look up a template by its stable slug id. */
export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}
