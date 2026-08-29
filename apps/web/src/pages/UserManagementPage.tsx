import { useState } from 'react';
import { Container, Box, Tabs, Tab, Paper } from '@mui/material';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../hooks/usePermissions';
import { UserList } from '../components/admin/UserList';
import { AllowlistTable } from '../components/admin/AllowlistTable';
import { AdminPageHeader } from '../components/admin/AdminPageHeader';
import { scrollableTabsProps } from '../components/common/tabs';

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
      <Box sx={{ py: { xs: 2, sm: 4 } }}>
        <AdminPageHeader
          title={<>User Management</>}
          description={
            <>
              Manage users and email allowlist
            </>
          }
        />

        <Paper sx={{ mt: 2 }}>
          <Tabs
            {...scrollableTabsProps}
            value={tabIndex}
            onChange={(_, newValue) => setTabIndex(newValue)}
            sx={{ borderBottom: 1, borderColor: 'divider' }}
          >
            <Tab label="Users" />
            <Tab label="Allowlist" />
          </Tabs>

          <Box sx={{ p: { xs: 2, sm: 3 } }}>
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
