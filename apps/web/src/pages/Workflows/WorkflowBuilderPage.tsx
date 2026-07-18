// ---------------------------------------------------------------------------
// Workflow builder — form-based rule builder (Subject · Trigger · If · Then ·
// Safety) with a live plain-language summary and match-preview panel.
//
// Template hydration contract (from the templates gallery):
//   navigate(`/workflows/new?template=<id>`, { state: { template } })
//   Resolution order: location.state.template → getWorkflowTemplate(?template) → blank.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Snackbar,
  Stack,
} from '@mui/material';
import { Close as CloseIcon, Save as SaveIcon } from '@mui/icons-material';
import {
  useParams,
  useLocation,
  useSearchParams,
  useNavigate,
} from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { usePermissions } from '../../hooks/usePermissions';
import { useWorkflowSubjects } from '../../hooks/useWorkflowSubjects';
import { useWorkflow } from '../../hooks/useWorkflow';
import { useWorkflowMutations } from '../../hooks/useWorkflowMutations';
import { getWorkflowTemplate } from '../../constants/workflowTemplates';
import type { WorkflowTemplate } from '../../constants/workflowTemplates';
import { isValidCron } from '../../utils/workflowCron';
import {
  builderReducer,
  blankState,
  stateFromTemplate,
  stateFromWorkflow,
} from './builderState';
import { SubjectBlock } from '../../components/workflows/builder/SubjectBlock';
import { TriggerBlock } from '../../components/workflows/builder/TriggerBlock';
import { ConditionsBlock } from '../../components/workflows/builder/ConditionsBlock';
import { ActionsBlock } from '../../components/workflows/builder/ActionsBlock';
import { WorkflowPreviewPanel } from '../../components/workflows/builder/WorkflowPreviewPanel';
import { api } from '../../services/api';
import type { CreateWorkflowDto, UpdateWorkflowDto } from '../../types/workflows';

/** Subset of `workflows.*` system settings the builder reads (admin-only). */
interface WorkflowSystemSettings {
  allowHardDelete?: boolean;
  maxItemsPerRun?: number;
  requirePreview?: boolean;
}

const GATED_ACTION_TYPES = new Set(['hard_delete']);

export default function WorkflowBuilderPage() {
  const { id } = useParams<{ id?: string }>();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const { activeCircle, activeCircleRole } = useCircle();
  const { hasPermission } = usePermissions();
  const {
    subjects,
    enabled: featureEnabled,
    isLoading: subjectsLoading,
    error: subjectsError,
  } = useWorkflowSubjects();
  const { workflow, isLoading: workflowLoading, error: workflowError, fetchWorkflow } =
    useWorkflow();
  const { createWorkflow, updateWorkflow, isSaving } = useWorkflowMutations();

  const [state, dispatch] = useReducer(builderReducer, undefined, blankState);
  const hydratedRef = useRef(false);

  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Admin-only `workflows.*` settings (cap, requirePreview, allowHardDelete).
  // Non-admins get 403 here; we fall back to safe defaults.
  const [sysWorkflows, setSysWorkflows] = useState<WorkflowSystemSettings | null>(null);
  const canReadSettings = hasPermission('system_settings:read');
  useEffect(() => {
    if (!canReadSettings) return;
    let active = true;
    void api
      .get<{ workflows?: WorkflowSystemSettings }>('/system-settings')
      .then((res) => active && setSysWorkflows(res.workflows ?? {}))
      .catch(() => active && setSysWorkflows(null));
    return () => {
      active = false;
    };
  }, [canReadSettings]);

  // null when unknown (non-admin); the backend still enforces the gate.
  const hardDeleteAllowed: boolean | null = sysWorkflows
    ? sysWorkflows.allowHardDelete ?? false
    : null;

  const canManage =
    (activeCircleRole === 'collaborator' || activeCircleRole === 'circle_admin') &&
    hasPermission('media:write');

  // Load the existing workflow when editing.
  useEffect(() => {
    if (isEdit && id) void fetchWorkflow(id);
  }, [isEdit, id, fetchWorkflow]);

  // Hydrate the draft exactly once, from the right source.
  useEffect(() => {
    if (hydratedRef.current) return;
    if (isEdit) {
      if (workflow) {
        dispatch({ kind: 'replace', state: stateFromWorkflow(workflow) });
        hydratedRef.current = true;
      }
      return;
    }
    // Create mode: template via router state, else ?template=<id>, else blank.
    const stateTemplate = (location.state as { template?: WorkflowTemplate } | null)?.template;
    const paramTemplate = searchParams.get('template');
    const template = stateTemplate ?? (paramTemplate ? getWorkflowTemplate(paramTemplate) : undefined);
    if (template) {
      dispatch({ kind: 'replace', state: stateFromTemplate(template) });
    }
    hydratedRef.current = true;
  }, [isEdit, workflow, location.state, searchParams]);

  const subjectEntry = useMemo(
    () => subjects?.find((s) => s.subject === state.definition.subject),
    [subjects, state.definition.subject],
  );

  // Validation --------------------------------------------------------------
  const hasGatedAction = state.definition.actions.some((a) =>
    GATED_ACTION_TYPES.has(a.type),
  );
  const gatedActionError =
    hasGatedAction && state.trigger !== 'manual'
      ? 'Permanent delete is only allowed on manual-trigger workflows. Switch the trigger to Manual or remove the action.'
      : null;

  const nameError = submitAttempted && state.name.trim() === '';
  const cronError =
    state.trigger === 'scheduled' && !isValidCron(state.cronExpression);

  const canSave = !isSaving && canManage && Boolean(activeCircle);

  const handleSave = async () => {
    setSubmitAttempted(true);
    setSaveError(null);
    if (!activeCircle) return;
    if (state.name.trim() === '') return;
    if (state.trigger === 'scheduled' && cronError) return;
    if (gatedActionError) return;

    const cronExpression =
      state.trigger === 'scheduled' ? state.cronExpression.trim() : null;

    try {
      if (isEdit && id) {
        const dto: UpdateWorkflowDto = {
          name: state.name.trim(),
          description: state.description.trim() || null,
          enabled: state.enabled,
          trigger: state.trigger,
          cronExpression,
          definition: state.definition,
        };
        const updated = await updateWorkflow(id, dto);
        navigate(`/workflows/${updated.id}`);
      } else {
        const dto: CreateWorkflowDto = {
          circleId: activeCircle.id,
          name: state.name.trim(),
          description: state.description.trim() || null,
          enabled: state.enabled,
          trigger: state.trigger,
          cronExpression,
          definition: state.definition,
        };
        const created = await createWorkflow(dto);
        navigate(`/workflows/${created.id}`);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save workflow');
    }
  };

  // --- Guard states --------------------------------------------------------
  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to build a workflow.</Alert>
      </Box>
    );
  }

  if (subjectsLoading || (isEdit && workflowLoading && !hydratedRef.current)) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (featureEnabled === false) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">The Workflows feature is not enabled.</Alert>
      </Box>
    );
  }

  if (subjectsError || workflowError) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="error">{subjectsError || workflowError}</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1400, mx: 'auto' }}>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 3,
          gap: 1,
          flexWrap: 'wrap',
        }}
      >
        <Typography variant="h5" component="h1">
          {isEdit ? 'Edit workflow' : 'New workflow'}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="text"
            startIcon={<CloseIcon />}
            onClick={() => navigate('/workflows')}
            sx={{ minHeight: 44 }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            startIcon={isSaving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
            onClick={() => void handleSave()}
            disabled={!canSave}
            sx={{ minHeight: 44 }}
          >
            {isSaving ? 'Saving…' : isEdit ? 'Save changes' : 'Create workflow'}
          </Button>
        </Box>
      </Box>

      {!canManage && (
        <Alert severity="info" sx={{ mb: 2 }}>
          You have read-only access to this workflow. Collaborator role and
          media:write are required to edit.
        </Alert>
      )}

      <Box
        sx={{
          display: 'flex',
          gap: 3,
          alignItems: 'flex-start',
          flexDirection: { xs: 'column', md: 'row' },
        }}
      >
        {/* Main column — stacked blocks */}
        <Stack spacing={2.5} sx={{ flex: 1, minWidth: 0 }}>
          {subjects && (
            <SubjectBlock
              subjects={subjects}
              value={state.definition.subject}
              onChange={() => {
                /* v1: single Subject; selection is fixed to media_item */
              }}
            />
          )}

          <TriggerBlock
            subject={subjectEntry}
            name={state.name}
            description={state.description}
            enabled={state.enabled}
            trigger={state.trigger}
            cronExpression={state.cronExpression}
            onName={(v) => dispatch({ kind: 'setName', value: v })}
            onDescription={(v) => dispatch({ kind: 'setDescription', value: v })}
            onEnabled={(v) => dispatch({ kind: 'setEnabled', value: v })}
            onTrigger={(v) => dispatch({ kind: 'setTrigger', value: v })}
            onCron={(v) => dispatch({ kind: 'setCron', value: v })}
            gatedActionError={gatedActionError}
            nameError={nameError}
          />

          {subjectEntry && (
            <ConditionsBlock
              circleId={activeCircle.id}
              fields={subjectEntry.fields}
              match={state.definition.match}
              conditions={state.definition.conditions}
              dispatch={dispatch}
            />
          )}

          {subjectEntry && (
            <ActionsBlock
              circleId={activeCircle.id}
              actionCatalog={subjectEntry.actions}
              actions={state.definition.actions}
              dispatch={dispatch}
              hardDeleteAllowed={hardDeleteAllowed}
            />
          )}

          {/* Safety block is added in a following checkpoint. */}
        </Stack>

        <WorkflowPreviewPanel
          circleId={activeCircle.id}
          definition={state.definition}
          subjectEntry={subjectEntry}
          trigger={state.trigger}
          cronExpression={state.cronExpression}
        />
      </Box>

      <Snackbar
        open={Boolean(saveError)}
        autoHideDuration={6000}
        onClose={() => setSaveError(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSaveError(null)} severity="error" sx={{ width: '100%' }}>
          {saveError}
        </Alert>
      </Snackbar>
    </Box>
  );
}
