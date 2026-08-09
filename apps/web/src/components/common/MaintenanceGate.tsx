import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { usePermissions } from '../../hooks/usePermissions';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import MaintenancePage from '../../pages/MaintenancePage';

interface MaintenanceGateProps {
  children: ReactNode;
}

/**
 * Swaps the whole router for the maintenance screen once the API has reported
 * a maintenance 503 (issue #348).
 *
 * Sits INSIDE ThemeProvider but OUTSIDE <Routes> so the takeover is genuinely
 * global — every route, authenticated or not — rather than something each page
 * has to remember to handle.
 *
 * The admin escape hatch is the lockout safeguard's frontend half. A 503 that
 * reaches an admin means `allowAdmins: false`, which the backend documents as
 * the one setting that can lock you out of the UI; without a way back in, the
 * only recovery would be the `MAINTENANCE_MODE=false` env break-glass plus a
 * restart. Because the maintenance controller itself is exempt from the block,
 * the toggle page still works — so the gate lets an explicit admin choice
 * suppress the takeover for the rest of the session. It is deliberately
 * one-way and not persisted: nothing here weakens the server-side block, it
 * only stops this tab from covering the UI.
 */
export function MaintenanceGate({ children }: MaintenanceGateProps) {
  const notice = useMaintenanceMode();
  const { isAdmin } = usePermissions();
  const [bypassed, setBypassed] = useState(false);

  const handleContinueAsAdmin = useCallback(() => setBypassed(true), []);

  if (notice && !bypassed) {
    return (
      <MaintenancePage
        onContinueAsAdmin={isAdmin ? handleContinueAsAdmin : undefined}
      />
    );
  }

  return <>{children}</>;
}
