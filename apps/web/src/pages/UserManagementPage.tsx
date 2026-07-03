import { useState } from 'react';
import { Container, Typography, Box, Tabs, Tab, Paper, Link } from '@mui/material';
import { Navigate, Link as RouterLink } from 'react-router-dom';
import { usePermissions } from '../hooks/usePermissions';
import { UserList } from '../components/admin/UserList';
import { AllowlistTable } from '../components/admin/AllowlistTable';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel({ children, value, index }: TabPanelProps) {
  return (
    <div role="tabpanel" hidden={value !== index}>
      {value === index && <Box sx={{ py: 3 }}>{children}</Box>}
    </div>
  );
}

export default function UserManagementPage() {
  const { hasPermission } = usePermissions();
  const [tabIndex, setTabIndex] = useState(0);

  // Check permission - require users:read to access
  if (!hasPermission('users:read')) {
    return <Navigate to="/" replace />;
  }

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Link
          component={RouterLink}
          to="/admin/settings"
          underline="hover"
          variant="body2"
          sx={{ display: 'inline-block', mb: 2 }}
        >
          &larr; Back to Settings
        </Link>

        <Typography variant="h4" component="h1" gutterBottom>
          User Management
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Manage users and email allowlist
        </Typography>

        <Paper sx={{ mt: 2 }}>
          <Tabs
            value={tabIndex}
            onChange={(_, newValue) => setTabIndex(newValue)}
            sx={{ borderBottom: 1, borderColor: 'divider' }}
          >
            <Tab label="Users" />
            <Tab label="Allowlist" />
          </Tabs>

          <Box sx={{ p: 3 }}>
            <TabPanel value={tabIndex} index={0}>
              <UserList />
            </TabPanel>

            <TabPanel value={tabIndex} index={1}>
              <AllowlistTable />
            </TabPanel>
          </Box>
        </Paper>
      </Box>
    </Container>
  );
}
