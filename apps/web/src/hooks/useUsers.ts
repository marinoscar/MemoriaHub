import { useState, useCallback } from 'react';
import type { UserListItem, UsersResponse } from '../types';
import {
  getUsers as getUsersApi,
  updateUser as updateUserApi,
  updateUserRoles as updateUserRolesApi,
} from '../services/api';

interface UseUsersResult {
  users: UserListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  isLoading: boolean;
  error: string | null;
  fetchUsers: (params?: {
    page?: number;
    pageSize?: number;
    search?: string;
    role?: string;
    isActive?: boolean;
  }) => Promise<void>;
  updateUser: (
    id: string,
    data: { displayName?: string; isActive?: boolean },
  ) => Promise<void>;
  updateUserRoles: (id: string, roles: string[]) => Promise<void>;
}

export function useUsers(): UseUsersResult {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [totalPages, setTotalPages] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUsers = useCallback(
    async (params?: {
      page?: number;
      pageSize?: number;
      search?: string;
      role?: string;
      isActive?: boolean;
    }) => {
      setIsLoading(true);
      setError(null);
      try {
        const response: UsersResponse = await getUsersApi(params);
        setUsers(response.items);
        setTotal(response.total);
        setPage(response.page);
        setPageSize(response.pageSize);
        setTotalPages(response.totalPages);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch users';
        setError(message);
        setUsers([]);
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const updateUser = useCallback(
    async (id: string, data: { displayName?: string; isActive?: boolean }) => {
      setError(null);
      try {
        const updatedUser = await updateUserApi(id, data);
        // Update the user in the list
        setUsers((prevUsers) =>
          prevUsers.map((user) => (user.id === id ? updatedUser : user)),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update user';
        setError(message);
        throw err;
      }
    },
    [],
  );

  const updateUserRoles = useCallback(
    async (id: string, roles: string[]) => {
      setError(null);
      try {
        const updatedUser = await updateUserRolesApi(id, roles);
        // Update the user in the list
        setUsers((prevUsers) =>
          prevUsers.map((user) => (user.id === id ? updatedUser : user)),
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to update user roles';
        setError(message);
        throw err;
      }
    },
    [],
  );

  return {
    users,
    total,
    page,
    pageSize,
    totalPages,
    isLoading,
    error,
    fetchUsers,
    updateUser,
    updateUserRoles,
  };
}
