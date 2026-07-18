/**
 * RTL tests for WorkflowPreviewPanel (issue #141 — Workflows Phase 3 web UI).
 *
 * Covers two issue bullets:
 *   - "Live plain-language summary" updates as the draft changes.
 *   - "Preview debounce + capped rendering": a definition change triggers a
 *     debounced (600ms) preview call (fake timers); `capped` renders as
 *     "10,000+"; only the first 12 sample thumbnails render.
 *
 * `useWorkflowPreview` is mocked directly (the panel's only network-adjacent
 * dependency) so these tests exercise real component logic — the debounce
 * timer, the sanitize-then-preview wiring, and the render branches — without
 * a real fetch or MSW handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '../../../utils/test-utils';
import { WorkflowPreviewPanel } from '../../../../components/workflows/builder/WorkflowPreviewPanel';
import type {
  WorkflowDefinition,
  SubjectRegistryEntry,
  WorkflowPreviewResponse,
} from '../../../../types/workflows';

vi.mock('../../../../hooks/useWorkflowPreview', () => ({
  useWorkflowPreview: vi.fn(),
}));

import { useWorkflowPreview } from '../../../../hooks/useWorkflowPreview';

const mockUseWorkflowPreview = vi.mocked(useWorkflowPreview);

type HookReturn = ReturnType<typeof useWorkflowPreview>;

function makeHook(overrides: Partial<HookReturn> = {}): HookReturn {
  return {
    preview: vi.fn().mockResolvedValue(null),
    data: null,
    isLoading: false,
    error: null,
    reset: vi.fn(),
    ...overrides,
  } as HookReturn;
}

const SUBJECT: SubjectRegistryEntry = {
  subject: 'media_item',
  label: 'Media Items',
  triggers: ['manual', 'on_media_enriched', 'scheduled'],
  fields: [
    {
      key: 'country',
      label: 'Country',
      group: 'Location',
      type: 'string',
      operators: ['equals'],
      valueType: 'string',
      dependency: 'metadata',
    },
  ],
  actions: [{ type: 'archive', label: 'Archive' }],
};

function baseDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    version: 1,
    subject: 'media_item',
    match: 'all',
    conditions: [],
    actions: [],
    ...overrides,
  };
}

function sampleItem(id: string) {
  return {
    id,
    type: 'photo',
    capturedAt: null,
    filename: `${id}.jpg`,
    width: 100,
    height: 100,
    thumbnailUrl: `https://cdn.example.com/${id}.jpg`,
  };
}

describe('WorkflowPreviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('plain-language summary', () => {
    it('renders the sentence for the current draft and updates it as the draft changes', () => {
      mockUseWorkflowPreview.mockReturnValue(makeHook());

      const { rerender } = render(
        <WorkflowPreviewPanel
          circleId="circle-1"
          definition={baseDefinition()}
          subjectEntry={SUBJECT}
          trigger="manual"
          cronExpression=""
        />,
      );

      expect(screen.getByText('In plain language')).toBeInTheDocument();
      expect(screen.getByText(/for every item, do nothing yet\./i)).toBeInTheDocument();

      rerender(
        <WorkflowPreviewPanel
          circleId="circle-1"
          definition={baseDefinition({
            conditions: [{ field: 'country', op: 'equals', value: 'Italy' }],
            actions: [{ type: 'archive' }],
          })}
          subjectEntry={SUBJECT}
          trigger="on_media_enriched"
          cronExpression=""
        />,
      );

      expect(
        screen.getByText(
          'When new media is enriched, if the country is “Italy”, archive it.',
        ),
      ).toBeInTheDocument();
    });
  });

  describe('debounced preview', () => {
    it('does not call preview() before the 600ms debounce elapses, then calls it once with the sanitized definition', () => {
      vi.useFakeTimers();
      const previewMock = vi.fn().mockResolvedValue(null);
      mockUseWorkflowPreview.mockReturnValue(makeHook({ preview: previewMock }));

      const definition = baseDefinition({
        conditions: [{ field: 'country', op: 'equals', value: 'Italy' }],
      });

      render(
        <WorkflowPreviewPanel
          circleId="circle-1"
          definition={definition}
          subjectEntry={SUBJECT}
          trigger="manual"
          cronExpression=""
        />,
      );

      expect(previewMock).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(599);
      });
      expect(previewMock).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(previewMock).toHaveBeenCalledTimes(1);
      // The single complete leaf survives sanitizeDefinitionForPreview
      // unchanged, so the sanitized definition is deep-equal to the input.
      expect(previewMock).toHaveBeenCalledWith({ circleId: 'circle-1', definition });
    });

    it('collapses rapid successive definition changes into a single debounced call', () => {
      vi.useFakeTimers();
      const previewMock = vi.fn().mockResolvedValue(null);
      mockUseWorkflowPreview.mockReturnValue(makeHook({ preview: previewMock }));

      const defA = baseDefinition({
        conditions: [{ field: 'country', op: 'equals', value: 'Italy' }],
      });
      const defB = baseDefinition({
        conditions: [{ field: 'country', op: 'equals', value: 'France' }],
      });

      const { rerender } = render(
        <WorkflowPreviewPanel
          circleId="circle-1"
          definition={defA}
          subjectEntry={SUBJECT}
          trigger="manual"
          cronExpression=""
        />,
      );

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(previewMock).not.toHaveBeenCalled();

      // A second edit arrives before the first debounce window closes — the
      // timer restarts rather than firing twice.
      rerender(
        <WorkflowPreviewPanel
          circleId="circle-1"
          definition={defB}
          subjectEntry={SUBJECT}
          trigger="manual"
          cronExpression=""
        />,
      );

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(previewMock).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(previewMock).toHaveBeenCalledTimes(1);
      expect(previewMock).toHaveBeenCalledWith({ circleId: 'circle-1', definition: defB });
    });

    it('does not schedule a preview call when circleId is empty', () => {
      vi.useFakeTimers();
      const previewMock = vi.fn().mockResolvedValue(null);
      mockUseWorkflowPreview.mockReturnValue(makeHook({ preview: previewMock }));

      render(
        <WorkflowPreviewPanel
          circleId=""
          definition={baseDefinition()}
          subjectEntry={SUBJECT}
          trigger="manual"
          cronExpression=""
        />,
      );

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(previewMock).not.toHaveBeenCalled();
    });
  });

  describe('match count rendering', () => {
    it('renders a plain count when not capped', () => {
      const data: WorkflowPreviewResponse = { matchedCount: 42, capped: false, sample: [] };
      mockUseWorkflowPreview.mockReturnValue(makeHook({ data }));

      render(
        <WorkflowPreviewPanel
          circleId="circle-1"
          definition={baseDefinition()}
          subjectEntry={SUBJECT}
          trigger="manual"
          cronExpression=""
        />,
      );

      expect(screen.getByText('42')).toBeInTheDocument();
      expect(screen.queryByText(/42\+/)).not.toBeInTheDocument();
    });

    it('renders "N+" when the preview response is capped', () => {
      const data: WorkflowPreviewResponse = { matchedCount: 10000, capped: true, sample: [] };
      mockUseWorkflowPreview.mockReturnValue(makeHook({ data }));

      render(
        <WorkflowPreviewPanel
          circleId="circle-1"
          definition={baseDefinition()}
          subjectEntry={SUBJECT}
          trigger="manual"
          cronExpression=""
        />,
      );

      expect(screen.getByText('10,000+')).toBeInTheDocument();
    });

    it('shows a loading indicator while the preview is in flight', () => {
      mockUseWorkflowPreview.mockReturnValue(makeHook({ isLoading: true }));

      render(
        <WorkflowPreviewPanel
          circleId="circle-1"
          definition={baseDefinition()}
          subjectEntry={SUBJECT}
          trigger="manual"
          cronExpression=""
        />,
      );

      expect(screen.getByText(/counting matches/i)).toBeInTheDocument();
    });

    it('surfaces a preview error', () => {
      mockUseWorkflowPreview.mockReturnValue(makeHook({ error: 'Preview failed' }));

      render(
        <WorkflowPreviewPanel
          circleId="circle-1"
          definition={baseDefinition()}
          subjectEntry={SUBJECT}
          trigger="manual"
          cronExpression=""
        />,
      );

      expect(screen.getByText('Preview failed')).toBeInTheDocument();
    });
  });

  describe('sample grid', () => {
    it('renders only the first 12 sample thumbnails even when more are returned', () => {
      const sample = Array.from({ length: 20 }, (_, i) => sampleItem(`item-${i}`));
      const data: WorkflowPreviewResponse = { matchedCount: 20, capped: false, sample };
      mockUseWorkflowPreview.mockReturnValue(makeHook({ data }));

      render(
        <WorkflowPreviewPanel
          circleId="circle-1"
          definition={baseDefinition()}
          subjectEntry={SUBJECT}
          trigger="manual"
          cronExpression=""
        />,
      );

      expect(screen.getAllByRole('img')).toHaveLength(12);
    });

    it('shows a "no items match yet" notice for a zero-match, non-loading result', () => {
      const data: WorkflowPreviewResponse = { matchedCount: 0, capped: false, sample: [] };
      mockUseWorkflowPreview.mockReturnValue(makeHook({ data }));

      render(
        <WorkflowPreviewPanel
          circleId="circle-1"
          definition={baseDefinition()}
          subjectEntry={SUBJECT}
          trigger="manual"
          cronExpression=""
        />,
      );

      expect(screen.getByText(/no items match yet/i)).toBeInTheDocument();
    });
  });
});
