/**
 * RTL tests for WorkflowBuilderPage (issue #141 — Workflows Phase 3 web UI).
 *
 * Covers the "Template hydration" bullet: navigating to the builder with a
 * template pre-fills the form, via BOTH hydration paths documented in the
 * component's own header comment —
 *   1. router state:      navigate('/workflows/new', { state: { template } })
 *   2. query param:       navigate('/workflows/new?template=<id>')
 *
 * A real MemoryRouter (not a mocked useParams/useLocation) drives this test,
 * since the hydration effect reads `useLocation().state` and
 * `useSearchParams()` directly — the very thing under test. Every data hook
 * is mocked so the page never touches the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../hooks/useCircle', () => ({ useCircle: vi.fn() }));
vi.mock('../../../hooks/usePermissions', () => ({ usePermissions: vi.fn() }));
vi.mock('../../../hooks/useWorkflowSubjects', () => ({ useWorkflowSubjects: vi.fn() }));
vi.mock('../../../hooks/useWorkflow', () => ({ useWorkflow: vi.fn() }));
vi.mock('../../../hooks/useWorkflowMutations', () => ({ useWorkflowMutations: vi.fn() }));
// The preview panel's own hook is mocked so this page-level test never fires
// a real (debounced) network call or leaves a dangling timer — preview
// behavior itself is covered by WorkflowPreviewPanel.test.tsx.
vi.mock('../../../hooks/useWorkflowPreview', () => ({ useWorkflowPreview: vi.fn() }));
vi.mock('../../../services/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/media')>();
  return {
    ...actual,
    getExploreTags: vi.fn().mockResolvedValue([]),
    listAlbums: vi.fn().mockResolvedValue({ items: [], meta: { page: 1, pageSize: 200, totalItems: 0, totalPages: 0 } }),
  };
});

import WorkflowBuilderPage from '../../../pages/Workflows/WorkflowBuilderPage';
import { useCircle } from '../../../hooks/useCircle';
import { usePermissions } from '../../../hooks/usePermissions';
import { useWorkflowSubjects } from '../../../hooks/useWorkflowSubjects';
import { useWorkflow } from '../../../hooks/useWorkflow';
import { useWorkflowMutations } from '../../../hooks/useWorkflowMutations';
import { useWorkflowPreview } from '../../../hooks/useWorkflowPreview';
import { WORKFLOW_TEMPLATES } from '../../../constants/workflowTemplates';
import type { SubjectRegistryEntry } from '../../../types/workflows';

const mockUseCircle = vi.mocked(useCircle);
const mockUsePermissions = vi.mocked(usePermissions);
const mockUseWorkflowSubjects = vi.mocked(useWorkflowSubjects);
const mockUseWorkflow = vi.mocked(useWorkflow);
const mockUseWorkflowMutations = vi.mocked(useWorkflowMutations);
const mockUseWorkflowPreview = vi.mocked(useWorkflowPreview);

// A registry entry covering exactly the fields/action the "Clean up
// screenshots" template's definition references.
const SUBJECT: SubjectRegistryEntry = {
  subject: 'media_item',
  label: 'Media Items',
  triggers: ['manual', 'on_media_enriched', 'scheduled'],
  fields: [
    { key: 'filename', label: 'Filename', group: 'File', type: 'string', operators: ['contains', 'starts_with', 'equals'], valueType: 'string', dependency: 'metadata' },
    { key: 'mimeType', label: 'Mime type', group: 'Media', type: 'enum', operators: ['equals'], valueType: 'enum', enumValues: ['image/png'], dependency: 'metadata' },
    { key: 'missingCamera', label: 'Missing camera', group: 'Media', type: 'boolean', operators: ['is'], valueType: 'boolean', dependency: 'metadata' },
    { key: 'missingCapturedAt', label: 'Missing capture date', group: 'Dates', type: 'boolean', operators: ['is'], valueType: 'boolean', dependency: 'metadata' },
  ],
  actions: [{ type: 'move_to_trash', label: 'Move to Trash' }],
};

const EXPECTED_SENTENCE =
  'When new media is enriched, if the filename contains “screenshot” or ' +
  '(the mime type is image/png, missing camera and missing capture date), move it to Trash.';

function renderBuilder(initialEntries: Parameters<typeof MemoryRouter>[0]['initialEntries']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <WorkflowBuilderPage />
    </MemoryRouter>,
  );
}

describe('WorkflowBuilderPage — template hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCircle.mockReturnValue({
      activeCircle: { id: 'circle-1', name: 'Test Circle', description: null, ownerId: 'user-1', isPersonal: false, createdAt: '', updatedAt: '' },
      activeCircleId: 'circle-1',
      activeCircleRole: 'collaborator',
      circles: [],
      loading: false,
      setActiveCircle: vi.fn().mockResolvedValue(undefined),
      refreshCircles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof useCircle>);
    mockUsePermissions.mockReturnValue({
      permissions: new Set(['media:write']),
      roles: new Set<string>(),
      hasPermission: (p: string) => p === 'media:write',
      hasAnyPermission: () => true,
      hasAllPermissions: () => true,
      hasRole: () => false,
      hasAnyRole: () => false,
      isAdmin: false,
    } as unknown as ReturnType<typeof usePermissions>);
    mockUseWorkflowSubjects.mockReturnValue({
      subjects: [SUBJECT],
      enabled: true,
      isLoading: false,
      error: null,
    });
    mockUseWorkflow.mockReturnValue({
      workflow: null,
      isLoading: false,
      error: null,
      fetchWorkflow: vi.fn().mockResolvedValue(undefined),
    });
    mockUseWorkflowMutations.mockReturnValue({
      createWorkflow: vi.fn(),
      updateWorkflow: vi.fn(),
      deleteWorkflow: vi.fn(),
      runWorkflow: vi.fn(),
      approveRun: vi.fn(),
      cancelRun: vi.fn(),
      duplicateWorkflow: vi.fn(),
      setEnabled: vi.fn(),
      isSaving: false,
      error: null,
    } as unknown as ReturnType<typeof useWorkflowMutations>);
    mockUseWorkflowPreview.mockReturnValue({
      preview: vi.fn().mockResolvedValue(null),
      data: null,
      isLoading: false,
      error: null,
      reset: vi.fn(),
    });
  });

  it('pre-fills the form from a template passed via router state (from the templates gallery)', async () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === 'clean-up-screenshots')!;

    renderBuilder([{ pathname: '/workflows/new', state: { template } }]);

    expect(screen.getByRole('heading', { name: 'New workflow' })).toBeInTheDocument();
    // `findBy` flushes ConditionsBlock/ActionsBlock's tag+album fetch effect
    // inside act(), avoiding a spurious "not wrapped in act" warning from
    // that unrelated in-flight promise resolving after this test returns.
    expect(await screen.findByLabelText('Name', { exact: false })).toHaveValue(template.name);
    expect(screen.getByLabelText('Description')).toHaveValue(template.description);
    expect(
      screen.getByRole('radio', { name: 'When new media is enriched' }),
    ).toBeChecked();
    expect(screen.getByText(EXPECTED_SENTENCE)).toBeInTheDocument();
  });

  it('pre-fills the form from a template referenced by the ?template= query param', async () => {
    renderBuilder(['/workflows/new?template=clean-up-screenshots']);

    const template = WORKFLOW_TEMPLATES.find((t) => t.id === 'clean-up-screenshots')!;
    expect(await screen.findByLabelText('Name', { exact: false })).toHaveValue(template.name);
    expect(screen.getByLabelText('Description')).toHaveValue(template.description);
    expect(
      screen.getByRole('radio', { name: 'When new media is enriched' }),
    ).toBeChecked();
    expect(screen.getByText(EXPECTED_SENTENCE)).toBeInTheDocument();
  });

  it('prefers router state over the query param when both are present', async () => {
    const stateTemplate = WORKFLOW_TEMPLATES.find((t) => t.id === 'clean-up-screenshots')!;
    renderBuilder([
      { pathname: '/workflows/new', search: '?template=trip-album', state: { template: stateTemplate } },
    ]);

    // Router-state template ("Clean up screenshots") wins over the
    // query-param template ("Album from a trip").
    expect(await screen.findByLabelText('Name', { exact: false })).toHaveValue('Clean up screenshots');
  });

  it('starts from a blank draft when no template is referenced', async () => {
    renderBuilder(['/workflows/new']);

    expect(await screen.findByLabelText('Name', { exact: false })).toHaveValue('');
    expect(screen.getByLabelText('Description')).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'Manual — I run it myself' })).toBeChecked();
  });
});
