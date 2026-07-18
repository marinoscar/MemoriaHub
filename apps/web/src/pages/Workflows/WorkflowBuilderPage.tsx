// TODO: Phase 3 turn B — form-based rule builder (Subject·Trigger·If·Then), plain-language summary, live preview.
//
// Template hydration contract (set by the templates gallery in checkpoint 3):
//   navigate(`/workflows/new?template=<templateId>`, { state: { template: WorkflowTemplate } })
//   Builder resolves the starting definition by: location.state?.template first,
//   else look up WORKFLOW_TEMPLATES by the `?template=<id>` query param.
//   A blank "New workflow" navigates to /workflows/new with no state and no query param.
import { Box, Typography } from '@mui/material';
import { useParams, useLocation, useSearchParams } from 'react-router-dom';

export default function WorkflowBuilderPage() {
  const { id } = useParams<{ id?: string }>();
  // Read here so the next turn can wire up the template hydration contract above.
  useLocation();
  useSearchParams();

  const isEdit = Boolean(id);

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Typography variant="h5" gutterBottom>
        Workflow builder
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {isEdit
          ? `Editing workflow ${id} — builder coming in a later turn. (Placeholder stub.)`
          : 'Creating a new workflow — builder coming in a later turn. (Placeholder stub.)'}
      </Typography>
    </Box>
  );
}
