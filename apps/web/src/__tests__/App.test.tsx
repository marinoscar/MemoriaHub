import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import App from '../App';

describe('App', () => {
  it('renders without crashing and shows the application shell', async () => {
    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>
    );

    // The MSW handler for /api/auth/me returns a valid user, so the app renders
    // the authenticated layout. Wait for the application name in the AppBar.
    await waitFor(
      () => {
        // MemoriaHub title is always rendered in the AppBar regardless of route
        const appTitle = screen.queryByText(/MemoriaHub/i);
        // Fallback: if auth is still loading, login page elements may appear first
        const loginText = screen.queryByText(/sign in/i);
        expect(appTitle || loginText).toBeTruthy();
      },
      { timeout: 5000 }
    );
  });
});
