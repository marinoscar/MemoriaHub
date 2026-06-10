import { useState, useEffect } from 'react';
import {
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  TextField,
  IconButton,
  Chip,
  Box,
  Typography,
  Avatar,
  Menu,
  MenuItem,
  CircularProgress,
  Alert,
  Checkbox,
  ListItemText,
} from '@mui/material';
import { MoreVert as MoreVertIcon } from '@mui/icons-material';
import { useUsers } from '../../hooks/useUsers';
import type { UserListItem } from '../../types';

const AVAILABLE_ROLES = ['admin', 'contributor', 'viewer'];

export function UserList() {
  const {
    users,
    total,
    isLoading,
    error,
    fetchUsers,
    updateUser,
    updateUserRoles,
  } = useUsers();

  const [search, setSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [selectedUser, setSelectedUser] = useState<UserListItem | null>(null);
  const [rolesMenuOpen, setRolesMenuOpen] = useState(false);

  // Fetch data on mount and when pagination changes
  useEffect(() => {
    fetchUsers({
      page: currentPage + 1,
      pageSize: rowsPerPage,
      search: search || undefined,
    });
  }, [currentPage, rowsPerPage, search, fetchUsers]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setCurrentPage(0); // Reset to first page on search
  };

  const handleChangePage = (_: unknown, newPage: number) => {
    setCurrentPage(newPage);
  };

  const handleChangeRowsPerPage = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setCurrentPage(0);
  };

  const handleMenuOpen = (
    event: React.MouseEvent<HTMLElement>,
    user: UserListItem,
  ) => {
    setAnchorEl(event.currentTarget);
    setSelectedUser(user);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
    setRolesMenuOpen(false);
  };

  const handleToggleActive = async () => {
    if (!selectedUser) return;

    try {
      await updateUser(selectedUser.id, {
        isActive: !selectedUser.isActive,
      });
      handleMenuClose();
    } catch (err) {
      // Error handled by hook
    }
  };

  const handleRoleToggle = async (role: string) => {
    if (!selectedUser) return;

    try {
      const currentRoles = selectedUser.roles;
      const newRoles = currentRoles.includes(role)
        ? currentRoles.filter((r) => r !== role)
        : [...currentRoles, role];

      // Ensure at least one role
      if (newRoles.length === 0) {
        alert('User must have at least one role');
        return;
      }

      await updateUserRoles(selectedUser.id, newRoles);
    } catch (err) {
      // Error handled by hook
    }
  };

  const getStatusChip = (isActive: boolean) => {
    return isActive ? (
      <Chip label="Active" color="success" size="small" />
    ) : (
      <Chip label="Inactive" color="error" size="small" />
    );
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  const getDisplayName = (user: UserListItem) => {
    return user.displayName || user.providerDisplayName || 'No name';
  };

  return (
    <Paper sx={{ width: '100%', overflow: 'hidden' }}>
      <Box sx={{ p: 2 }}>
        <TextField
          label="Search by email or name"
          variant="outlined"
          size="small"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          fullWidth
        />
      </Box>

      {error && (
        <Alert severity="error" sx={{ mx: 2, mb: 2 }}>
          {error}
        </Alert>
      )}

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : users.length === 0 ? (
        <Box sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">
            {search ? 'No users found matching your search' : 'No users found'}
          </Typography>
        </Box>
      ) : (
        <>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>User</TableCell>
                  <TableCell>Display Name</TableCell>
                  <TableCell>Roles</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id} hover>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Avatar
                          src={user.profileImageUrl || undefined}
                          alt={user.email}
                          sx={{ width: 32, height: 32 }}
                        >
                          {user.email[0].toUpperCase()}
                        </Avatar>
                        <Typography variant="body2">{user.email}</Typography>
                      </Box>
                    </TableCell>
                    <TableCell>{getDisplayName(user)}</TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                        {user.roles.map((role) => (
                          <Chip key={role} label={role} size="small" />
                        ))}
                      </Box>
                    </TableCell>
                    <TableCell>{getStatusChip(user.isActive)}</TableCell>
                    <TableCell>{formatDate(user.createdAt)}</TableCell>
                    <TableCell align="right">
                      <IconButton
                        size="small"
                        onClick={(e) => handleMenuOpen(e, user)}
                      >
                        <MoreVertIcon />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={total}
            page={currentPage}
            onPageChange={handleChangePage}
            rowsPerPage={rowsPerPage}
            onRowsPerPageChange={handleChangeRowsPerPage}
            rowsPerPageOptions={[5, 10, 25, 50]}
          />
        </>
      )}

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl) && !rolesMenuOpen}
        onClose={handleMenuClose}
      >
        <MenuItem onClick={handleToggleActive}>
          {selectedUser?.isActive ? 'Deactivate User' : 'Activate User'}
        </MenuItem>
        <MenuItem
          onClick={() => setRolesMenuOpen(true)}
          sx={{ display: 'flex', justifyContent: 'space-between' }}
        >
          Change Roles
          <Typography variant="caption" sx={{ ml: 2 }}>
            &gt;
          </Typography>
        </MenuItem>
      </Menu>

      <Menu
        anchorEl={anchorEl}
        open={rolesMenuOpen}
        onClose={handleMenuClose}
        anchorOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'left',
        }}
      >
        {AVAILABLE_ROLES.map((role) => (
          <MenuItem key={role} onClick={() => handleRoleToggle(role)}>
            <Checkbox checked={selectedUser?.roles.includes(role) || false} />
            <ListItemText primary={role} />
          </MenuItem>
        ))}
      </Menu>
    </Paper>
  );
}
