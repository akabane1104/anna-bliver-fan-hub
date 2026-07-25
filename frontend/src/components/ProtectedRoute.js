import React, { useState, useEffect } from 'react';
import { Navigate } from 'react-router';
import { authService, permissionService } from '../services';

function ProtectedRoute({ children, adminOnly = false, requiredPermissions = [] }) {
  const [loading, setLoading] = useState(true);
  const [hasAccess, setHasAccess] = useState(false);
  const isAuthenticated = authService.isAuthenticated();
  const user = authService.getCurrentUser();
  const permissionKey = requiredPermissions.join('|');

  useEffect(() => {
    const checkAccess = async () => {
      if (!isAuthenticated) {
        setLoading(false);
        return;
      }

      // Admin always has access
      if (user?.role === 'admin') {
        setHasAccess(true);
        setLoading(false);
        return;
      }

      // Check adminOnly
      if (adminOnly) {
        setHasAccess(false);
        setLoading(false);
        return;
      }

      // Check required permissions
      const permissionsToCheck = permissionKey ? permissionKey.split('|') : [];
      if (permissionsToCheck.length > 0) {
        try {
          const userPerms = await permissionService.getMyPermissions();
          // Check if user has any of the required permissions
          const hasPermission = permissionsToCheck.some(perm =>
            userPerms.permissions?.includes(perm)
          );
          setHasAccess(hasPermission);
        } catch (error) {
          console.error('Error checking permissions:', error);
          setHasAccess(false);
        }
      } else {
        // No specific permissions required, just authentication
        setHasAccess(true);
      }

      setLoading(false);
    };

    checkAccess();
  }, [isAuthenticated, user?.role, adminOnly, permissionKey]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}>加载中...</div>;
  }

  if (!hasAccess) {
    return <Navigate to="/" replace />;
  }

  return children;
}

export default ProtectedRoute;
