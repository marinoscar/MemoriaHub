import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';

export function usePermissions() {
  const { user } = useAuth();

  const permissions = useMemo(() => {
    return new Set(user?.permissions || []);
  }, [user?.permissions]);

  const roles = useMemo(() => {
    return new Set(user?.roles?.map((r) => r.name) || []);
  }, [user?.roles]);

  const hasPermission = (permission: string): boolean => {
    return permissions.has(permission);
  };

  const hasAnyPermission = (...perms: string[]): boolean => {
    return perms.some((p) => permissions.has(p));
  };

  const hasAllPermissions = (...perms: string[]): boolean => {
    return perms.every((p) => permissions.has(p));
  };

  const hasRole = (role: string): boolean => {
    return roles.has(role);
  };

  const hasAnyRole = (...roleList: string[]): boolean => {
    return roleList.some((r) => roles.has(r));
  };

  const isAdmin = useMemo(() => {
    return roles.has('admin');
  }, [roles]);

  return {
    permissions,
    roles,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    hasRole,
    hasAnyRole,
    isAdmin,
  };
}
