import {
  Box,
  Alert,
  Link,
  Button,
} from '@mui/material';
import {
  BurstMode as BurstModeIcon,
} from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { useCircle } from '../hooks/useCircle';
import { useDashboard } from '../hooks/useDashboard';

export default function HomePage() {
  const { activeCircle, loading: circleLoading } = useCircle();
  const { data } = useDashboard();

  const showNoCircle = !activeCircle && !circleLoading;

  return (
    <Box sx={{ minHeight: '100vh', pb: { xs: 10, sm: 4 } }}>
      {/* No active circle */}
      {showNoCircle && (
        <Box sx={{ p: { xs: 2, md: 3 } }}>
          <Alert severity="info">
            Select or create a circle to get started.{' '}
            <Link component={RouterLink} to="/circles" underline="always">
              Go to Circles
            </Link>
          </Alert>
        </Box>
      )}

      {/* Pending burst groups banner */}
      {data?.counts?.pendingBurstGroups != null && data.counts.pendingBurstGroups > 0 && (
        <Alert
          severity="info"
          icon={<BurstModeIcon />}
          action={
            <Button size="small" component={RouterLink} to="/bursts">
              Review
            </Button>
          }
          sx={{ mx: { xs: 2, md: 3 }, mt: 2 }}
        >
          {data.counts.pendingBurstGroups} burst group{data.counts.pendingBurstGroups !== 1 ? 's' : ''} ready to review
        </Alert>
      )}
    </Box>
  );
}
