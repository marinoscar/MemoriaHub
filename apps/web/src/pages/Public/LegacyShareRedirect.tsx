/**
 * `/s/:token`: a public share link made before RETRO-I4 (#578).
 *
 * Old links carried the share token in the PATH. Each `media_shares` row was imported as a
 * platform link grant whose token is `lnk_` + the old one, and the platform's public page reads
 * the token from the URL FRAGMENT (`/s#lnk_...`), which a browser never sends to a server. So
 * this route only moves the token: `window.location.replace('/s#lnk_<token>')` (no history
 * entry). A token already carrying `lnk_` is not prefixed twice. Revoked and expired links land
 * on the same "This link is not available" as any other.
 *
 * The first request of an old link still carries its token in the path (and so in an access
 * log), as it always did; the redirect stops every request after it from doing so.
 */
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';

import { LoadingSpinner } from '../../components/common/LoadingSpinner';

/** The fragment URL an old `/s/<token>` link now opens. */
export function legacyShareTarget(token: string): string {
  const linkToken = token.startsWith('lnk_') ? token : `lnk_${token}`;
  return `/s#${linkToken}`;
}

export default function LegacyShareRedirect() {
  const { token = '' } = useParams<{ token: string }>();
  useEffect(() => {
    window.location.replace(token ? legacyShareTarget(token) : '/s');
  }, [token]);
  return <LoadingSpinner fullScreen />;
}
