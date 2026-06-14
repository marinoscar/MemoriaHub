import { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Container,
  Typography,
  Box,
  Paper,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  CircularProgress,
  Alert,
} from '@mui/material';
import { usePermissions } from '../../hooks/usePermissions';
import { useCircles } from '../../hooks/useCircles';

function AdminCirclesContent() {
  const { circles, loading, error, fetchCircles } = useCircles();

  useEffect(() => {
    void fetchCircles(true);
  }, [fetchCircles]);

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      <Typography variant="h5" component="h1" sx={{ mb: 3 }}>
        All Circles (Admin)
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Paper variant="outlined">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Owner ID</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {circles.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} align="center">
                    <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                      No circles found
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {circles.map((circle) => (
                <TableRow key={circle.id}>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 'medium' }}>
                      {circle.name}
                    </Typography>
                    {circle.description && (
                      <Typography variant="caption" color="text.secondary">
                        {circle.description}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                      {circle.ownerId}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {circle.isPersonal ? (
                      <Chip label="Personal" size="small" color="primary" variant="outlined" />
                    ) : (
                      <Chip label="Family" size="small" variant="outlined" />
                    )}
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">
                      {new Date(circle.createdAt).toLocaleDateString()}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
    </Container>
  );
}

export default function AdminCirclesPage() {
  const { isAdmin } = usePermissions();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <AdminCirclesContent />;
}
