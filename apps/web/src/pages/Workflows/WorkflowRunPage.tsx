// TODO: Phase 3 turn C — run review & progress (evaluating → awaiting approval → running → terminal), 2s status poll, approval typed-confirmation gate, exclusion checkboxes.
import { Box, Typography } from '@mui/material';
import { useParams } from 'react-router-dom';

export default function WorkflowRunPage() {
  const { runId } = useParams<{ id: string; runId: string }>();

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Typography variant="h5" gutterBottom>
        Workflow run
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Run {runId} — review & progress coming in a later turn. (Placeholder stub.)
      </Typography>
    </Box>
  );
}
