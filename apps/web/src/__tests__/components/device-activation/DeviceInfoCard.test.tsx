/**
 * DeviceInfoCard — unit tests.
 *
 * Issue #499: the approval card must show the requesting client's `name`
 * (e.g. "MemoriaHub Android · Pixel 8") and say when approving issues a
 * long-lived personal access token, so the user knows what they approve.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { DeviceInfoCard } from '../../../components/device-activation/DeviceInfoCard';
import type { DeviceActivationInfo } from '../../../types';

function info(clientInfo: DeviceActivationInfo['clientInfo']): DeviceActivationInfo {
  return {
    userCode: 'ABCD-1234',
    clientInfo,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
}

function renderCard(clientInfo: DeviceActivationInfo['clientInfo']) {
  return render(
    <DeviceInfoCard
      deviceInfo={info(clientInfo)}
      onApprove={vi.fn(async () => {})}
      onDeny={vi.fn(async () => {})}
      error={null}
    />,
  );
}

describe('DeviceInfoCard', () => {
  it('shows the client name with hostname and platform', () => {
    renderCard({
      tokenType: 'pat',
      name: 'MemoriaHub Android · Pixel 8',
      hostname: 'pixel-8',
      platform: 'android',
    });

    expect(screen.getByText('Application')).toBeInTheDocument();
    expect(screen.getByText('MemoriaHub Android · Pixel 8')).toBeInTheDocument();
    expect(screen.getByText('pixel-8 · android')).toBeInTheDocument();
  });

  it('warns that approving issues a long-lived personal access token', () => {
    renderCard({ tokenType: 'pat', name: 'MemoriaHub CLI' });

    expect(screen.getByText(/long-lived personal access token/i)).toBeInTheDocument();
  });

  it('shows neither the application row nor the PAT notice for a session request', () => {
    renderCard({ deviceName: 'Living room TV' });

    expect(screen.getByText('Living room TV')).toBeInTheDocument();
    expect(screen.queryByText('Application')).not.toBeInTheDocument();
    expect(screen.queryByText(/personal access token/i)).not.toBeInTheDocument();
  });
});
