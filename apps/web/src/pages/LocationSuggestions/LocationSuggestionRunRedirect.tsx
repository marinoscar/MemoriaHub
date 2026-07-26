import { Navigate, useParams } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Deprecated `/location-suggestion-runs/:runId` route (issue #190).
//
// Location-suggestion runs are now review runs: the data migrated into
// `review_runs` PRESERVING RUN UUIDs, and `ReviewRunPage` already renders the
// `location_suggestion` subject with the right nouns, labels and back-link. The
// dedicated page had nothing left that the shared page did not do, so it is
// gone and this route redirects instead.
//
// The route itself stays because links to it are already in the wild (bookmarks
// and anything the review-queue page emitted before this change) — the same
// reason the backend kept `/api/location-suggestion-runs/:id` as a deprecated
// alias. `replace` keeps the dead URL out of the history stack, so Back from
// the run page returns to wherever the user actually came from.
// ---------------------------------------------------------------------------

export default function LocationSuggestionRunRedirect() {
  const { runId } = useParams<{ runId: string }>();
  return <Navigate to={runId ? `/review-runs/${runId}` : '/location-suggestions'} replace />;
}
