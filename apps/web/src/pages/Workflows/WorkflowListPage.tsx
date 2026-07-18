// TODO(#141): full list page + templates gallery implemented in checkpoint 3
import { Box, Typography } from '@mui/material';

export default function WorkflowListPage() {
  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Typography variant="h5" gutterBottom>
        Workflows
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Workflow list — coming up in this turn. (Placeholder stub.)
      </Typography>
    </Box>
  );
}
