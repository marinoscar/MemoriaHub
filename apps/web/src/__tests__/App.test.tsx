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
    // the authenticated layout. Wait for the brand in the AppBar.
    await waitFor(
      () => {
        // The brand is the logo IMAGE at every breakpoint; the wordmark beside
        // it is gated on `isDesktopBrand` (AppBar.tsx) and so does not render
        // under jsdom, where that breakpoint query resolves false. Match the
        // logo by its alt text — `queryByText` cannot see an `alt` attribute,
        // which is exactly why this assertion broke when the navigation
        // overhaul (#394-#403) replaced the always-on text title.
        const appLogo = screen.queryByAltText(/MemoriaHub/i);
        // Still accept the wordmark, so the test keeps passing at a desktop
        // breakpoint (or if the gating is ever relaxed) rather than silently
        // depending on the wordmark being absent.
        const appTitle = screen.queryByText(/MemoriaHub/i);
        // Fallback: if auth is still loading, login page elements may appear first
        const loginText = screen.queryByText(/sign in/i);
        expect(appLogo || appTitle || loginText).toBeTruthy();
      },
      { timeout: 5000 }
    );
  });
});
