/**
 * RTL test for the deprecated `/location-suggestion-runs/:runId` route
 * (issue #190).
 *
 * Location-suggestion runs folded into the shared `review_runs` model with
 * their UUIDs preserved, so this route must keep resolving for links already
 * in the wild — it redirects to `/review-runs/:runId` rather than 404ing.
 * This is the client-side counterpart to the deprecated
 * `/api/location-suggestion-runs/:id` alias the backend kept.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import LocationSuggestionRunRedirect from '../../pages/LocationSuggestions/LocationSuggestionRunRedirect';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/location-suggestion-runs/:runId"
          element={<LocationSuggestionRunRedirect />}
        />
        <Route path="/location-suggestion-runs" element={<LocationSuggestionRunRedirect />} />
        <Route path="/review-runs/:runId" element={<div>review run page</div>} />
        <Route path="/location-suggestions" element={<div>suggestions queue</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LocationSuggestionRunRedirect', () => {
  it('redirects a legacy run URL to the shared review-run page, preserving the run id', () => {
    renderAt('/location-suggestion-runs/run-abc');

    expect(screen.getByText('review run page')).toBeInTheDocument();
  });

  it('falls back to the suggestions queue when no run id is present', () => {
    renderAt('/location-suggestion-runs');

    expect(screen.getByText('suggestions queue')).toBeInTheDocument();
  });
});
