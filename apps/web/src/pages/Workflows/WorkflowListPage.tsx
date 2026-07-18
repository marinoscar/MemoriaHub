import { useEffect, useState, useCallback } from 'react';
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Grid,
  Snackbar,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material';
import { Add as AddIcon, AccountTree as AccountTreeIcon } from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { useCircle } from '../../hooks/useCircle';
import { usePermissions } from '../../hooks/usePermissions';
import { useWorkflows } from '../../hooks/useWorkflows';
import { useWorkflowMutations } from '../../hooks/useWorkflowMutations';
import { WorkflowCard } from '../../components/workflows/WorkflowCard';
import { WorkflowTemplatesGallery } from '../../components/workflows/WorkflowTemplatesGallery';
import type { WorkflowTemplate } from '../../constants/workflowTemplates';
import type { Workflow } from '../../types/workflows';

export default function WorkflowListPage() {
  const navigate = useNavigate();
  const { activeCircle, activeCircleRole } = useCircle();
  const { hasPermission } = usePermissions();
  const { workflows, isLoading, error, fetchWorkflows } = useWorkflows();
  const { runWorkflow, duplicateWorkflow, deleteWorkflow, setEnabled } =
    useWorkflowMutations();

  // Local mirror of the fetched list so the enabled Switch can flip optimistically.
  const [items, setItems] = useState<Workflow[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);

  const canManage =
    (activeCircleRole === 'collaborator' || activeCircleRole === 'circle_admin') &&
    hasPermission('media:write');

  const refetch = useCallback(() => {
    if (!activeCircle) return;
    void fetchWorkflows({ circleId: activeCircle.id, pageSize: 100 });
  }, [activeCircle, fetchWorkflows]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    setItems(workflows);
  }, [workflows]);

  const handleSelectTemplate = useCallback(
    (t: WorkflowTemplate) => {
      // Template hydration contract: pass the full template via router state
      // (primary) and its id via the ?template= query param (fallback).
      navigate(`/workflows/new?template=${t.id}`, { state: { template: t } });
    },
    [navigate],
  );

  const handleOpen = useCallback(
    (w: Workflow) => {
      navigate(`/workflows/${w.id}`);
    },
    [navigate],
  );

  const handleToggleEnabled = useCallback(
    async (w: Workflow, enabled: boolean) => {
      // Optimistic flip.
      setItems((prev) =>
        prev.map((item) => (item.id === w.id ? { ...item, enabled } : item)),
      );
      try {
        await setEnabled(w.id, enabled);
      } catch (err) {
        // Revert to the server truth and surface the error.
        setItems((prev) =>
          prev.map((item) =>
            item.id === w.id ? { ...item, enabled: w.enabled } : item,
          ),
        );
        setErrorMsg(err instanceof Error ? err.message : 'Failed to update workflow');
      }
    },
    [setEnabled],
  );

  const handleRunNow = useCallback(
    async (w: Workflow) => {
      try {
        const result = await runWorkflow(w.id);
        setSuccessMsg('Run started');
        navigate(`/workflows/${w.id}/runs/${result.runId}`);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to start run');
      }
    },
    [runWorkflow, navigate],
  );

  const handleDuplicate = useCallback(
    async (w: Workflow) => {
      try {
        await duplicateWorkflow(w);
        setSuccessMsg('Workflow duplicated');
        refetch();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to duplicate workflow');
      }
    },
    [duplicateWorkflow, refetch],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteWorkflow(target.id);
      setSuccessMsg('Workflow deleted');
      refetch();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to delete workflow');
    }
  }, [deleteTarget, deleteWorkflow, refetch]);

  if (!activeCircle) {
    return (
      <Box sx={{ p: { xs: 2, md: 3 } }}>
        <Alert severity="info">Select a circle to view workflows.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 3,
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Typography variant="h5" component="h1">
          Workflows
        </Typography>
        {canManage && (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button
              variant="outlined"
              onClick={() => setShowTemplates((v) => !v)}
              sx={{ minHeight: 44 }}
            >
              Browse templates
            </Button>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => navigate('/workflows/new')}
              sx={{ minHeight: 44 }}
            >
              New workflow
            </Button>
          </Box>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      )}

      {/* Empty state */}
      {!isLoading && !error && items.length === 0 && (
        <>
          {canManage ? (
            <Box>
              <Typography variant="body1" sx={{ mb: 2 }}>
                Automate your library. Start from a template:
              </Typography>
              <WorkflowTemplatesGallery
                onSelect={handleSelectTemplate}
                onStartFromScratch={() => navigate('/workflows/new')}
                heading=""
              />
            </Box>
          ) : (
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <AccountTreeIcon sx={{ fontSize: 56, color: 'text.disabled', mb: 1 }} />
              <Typography variant="h6" color="text.secondary">
                No workflows yet.
              </Typography>
            </Box>
          )}
        </>
      )}

      {/* Non-empty: card grid */}
      {!isLoading && !error && items.length > 0 && (
        <Grid container spacing={2}>
          {items.map((w) => (
            <Grid key={w.id} size={{ xs: 12, sm: 6, md: 4 }}>
              <WorkflowCard
                workflow={w}
                canManage={canManage}
                onToggleEnabled={handleToggleEnabled}
                onOpen={handleOpen}
                onRunNow={handleRunNow}
                onDuplicate={handleDuplicate}
                onDelete={setDeleteTarget}
              />
            </Grid>
          ))}
        </Grid>
      )}

      {/* Templates section (toggled from the header, only when there are workflows) */}
      {canManage && showTemplates && items.length > 0 && (
        <Box sx={{ mt: 4 }}>
          <Divider sx={{ mb: 3 }} />
          <WorkflowTemplatesGallery onSelect={handleSelectTemplate} />
        </Box>
      )}

      {/* Delete confirm dialog */}
      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Delete workflow?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This permanently deletes <strong>{deleteTarget?.name}</strong>. This action
            cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => void handleDeleteConfirm()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Success feedback */}
      <Snackbar
        open={Boolean(successMsg)}
        autoHideDuration={4000}
        onClose={() => setSuccessMsg(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSuccessMsg(null)} severity="success" sx={{ width: '100%' }}>
          {successMsg}
        </Alert>
      </Snackbar>

      {/* Error feedback */}
      <Snackbar
        open={Boolean(errorMsg)}
        autoHideDuration={6000}
        onClose={() => setErrorMsg(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setErrorMsg(null)} severity="error" sx={{ width: '100%' }}>
          {errorMsg}
        </Alert>
      </Snackbar>
    </Box>
  );
}
