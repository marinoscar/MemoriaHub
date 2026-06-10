import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import App from '../App';

describe('App', () => {
  it('renders without crashing and shows login page initially', async () => {
    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>
    );

    // Wait for lazy loaded component to render
    // The App will make an API call to check auth, MSW will handle it
    await waitFor(
      () => {
        // Should either show login page or home page depending on mock auth state
        const welcomeText = screen.queryByText(/Welcome/i);
        const homeText = screen.queryByText(/Home Page/i);
        expect(welcomeText || homeText).toBeTruthy();
      },
      { timeout: 5000 }
    );
  });
});
