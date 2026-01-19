import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './theme';
import { ErrorBoundary } from './components/common';
import { AppRoutes } from './routes/AppRoutes';
import { useAuthStore } from './contexts';

/**
 * Root application component
 */
export function App() {
  const checkAuth = useAuthStore((state) => state.checkAuth);

  // Check authentication status on app load
  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
