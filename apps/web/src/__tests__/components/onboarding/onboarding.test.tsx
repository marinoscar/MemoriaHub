/**
 * First-run onboarding in the shell (RETRO-H3, #599): the welcome dialog, the banner and the
 * established-account rule, over the platform `OnboardingProvider` with a fake client.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { OnboardingProvider, type OnboardingClient, type OnboardingResponse } from '@marinoscar/platform-web/onboarding/headless';

import { OnboardingWelcome } from '../../../components/onboarding/OnboardingWelcome';
import { OnboardingBanner, chooseBannerAudience } from '../../../components/onboarding/OnboardingBanner';
import { WELCOME_PANES } from '../../../components/onboarding/memoriahubWelcomePanes';
import { FIRST_UPLOAD_STEP_ID, needsEstablishedMark } from '../../../platform/onboarding/establishedAccount';

type Step = OnboardingResponse['user'] extends infer B ? (B extends { steps: Array<infer S> } ? S : never) : never;

function step(id: string, status: 'done' | 'todo', tier: 'required' | 'recommended' | 'optional' = 'required'): Step {
  return {
    id,
    audience: 'user',
    tier,
    order: 1,
    title: id,
    description: 'd',
    actionLabel: 'Go',
    href: '/',
    skippable: tier !== 'required',
    status,
    detail: null,
    blockedReason: null,
    skipped: false,
  } as unknown as Step;
}

function block(steps: Step[]) {
  const completed = steps.filter((s) => (s as { status: string }).status === 'done').length;
  return { steps, completed, total: steps.length } as unknown as NonNullable<OnboardingResponse['user']>;
}

function response(opts: {
  firstUpload: 'done' | 'todo';
  settings?: Record<string, unknown>;
  admin?: NonNullable<OnboardingResponse['admin']> | null;
}): OnboardingResponse {
  return {
    settings: {
      welcomeSeenAt: null,
      checklistDismissedAt: null,
      adminDismissedAt: null,
      skipped: [],
      ...opts.settings,
    },
    user: block([step(FIRST_UPLOAD_STEP_ID, opts.firstUpload)]),
    admin: opts.admin ?? null,
  } as unknown as OnboardingResponse;
}

/** A client whose stored settings follow its writes, like the real `PATCH /api/user-settings`. */
function fakeClient(initial: OnboardingResponse) {
  let current = initial;
  const write = vi.fn(async (patch: Record<string, unknown>) => {
    current = { ...current, settings: { ...current.settings, ...patch } } as OnboardingResponse;
  });
  const client: OnboardingClient = {
    get: vi.fn(async () => current),
    metrics: vi.fn(),
    write,
  } as unknown as OnboardingClient;
  return { client, write };
}

function renderShell(client: OnboardingClient, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <OnboardingProvider appName="MemoriaHub" client={client}>
        <OnboardingBanner />
        <OnboardingWelcome />
      </OnboardingProvider>
    </MemoryRouter>,
  );
}

describe('needsEstablishedMark', () => {
  it('is true only for an unmarked account that already uploaded and never saw the welcome', () => {
    expect(needsEstablishedMark(null)).toBe(false);
    expect(needsEstablishedMark(response({ firstUpload: 'todo' }))).toBe(false);
    expect(needsEstablishedMark(response({ firstUpload: 'done' }))).toBe(true);
    expect(needsEstablishedMark(response({ firstUpload: 'done', settings: { welcomeSeenAt: '2026-01-01T00:00:00Z' } }))).toBe(false);
    expect(needsEstablishedMark(response({ firstUpload: 'done', settings: { checklistDismissedAt: '2026-01-01T00:00:00Z' } }))).toBe(false);
    // Marked once: the "Getting started" reopen clears the platform fields, not this one.
    expect(needsEstablishedMark(response({ firstUpload: 'done', settings: { establishedAt: '2026-01-01T00:00:00Z' } }))).toBe(false);
  });
});

describe('the welcome dialog', () => {
  it('opens once for a fresh user with the MemoriaHub pane, and "Later" stores it as seen', async () => {
    const { client, write } = fakeClient(response({ firstUpload: 'todo' }));
    renderShell(client);

    const dialog = await screen.findByTestId('welcome-dialog');
    expect(dialog).toHaveTextContent(WELCOME_PANES.user.lead);
    await userEvent.click(screen.getByRole('button', { name: 'Later' }));

    expect(write).toHaveBeenCalledWith(expect.objectContaining({ welcomeSeenAt: expect.any(String) }));
    await waitFor(() => expect(screen.queryByTestId('welcome-dialog')).not.toBeInTheDocument());
  });

  it('stays closed once seen', async () => {
    const { client, write } = fakeClient(response({ firstUpload: 'todo', settings: { welcomeSeenAt: '2026-01-01T00:00:00Z' } }));
    renderShell(client);
    await waitFor(() => expect(client.get).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByTestId('welcome-dialog')).not.toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();
  });

  it('never greets an established account: it marks it once instead, with no dialog and no banner', async () => {
    const { client, write } = fakeClient(response({ firstUpload: 'done' }));
    renderShell(client);

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        establishedAt: expect.any(String),
        welcomeSeenAt: expect.any(String),
        checklistDismissedAt: expect.any(String),
        adminDismissedAt: expect.any(String),
      }),
    );
    await act(async () => undefined);
    expect(screen.queryByTestId('welcome-dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('the onboarding banner', () => {
  it('shows the required steps left for a fresh user, and nothing on its own page', async () => {
    const { client } = fakeClient(response({ firstUpload: 'todo', settings: { welcomeSeenAt: '2026-01-01T00:00:00Z' } }));
    const { unmount } = renderShell(client);
    expect(await screen.findByText(/1 of 1 required step left/)).toBeInTheDocument();
    unmount();

    renderShell(client, '/settings/getting-started');
    await waitFor(() => expect(client.get).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByText(/required step/)).not.toBeInTheDocument();
  });

  it('is hidden once the required steps are done or the checklist was dismissed', () => {
    expect(chooseBannerAudience(response({ firstUpload: 'todo' }))).toBe('user');
    expect(
      chooseBannerAudience(response({ firstUpload: 'done', settings: { welcomeSeenAt: '2026-01-01T00:00:00Z' } })),
    ).toBeNull();
    expect(
      chooseBannerAudience(response({ firstUpload: 'todo', settings: { checklistDismissedAt: '2026-01-01T00:00:00Z' } })),
    ).toBeNull();
  });

  it('speaks to the administrator first, until the deployment checklist is dismissed', () => {
    const admin = block([step('memoriahub.storage_ready', 'todo')]) as unknown as NonNullable<OnboardingResponse['admin']>;
    expect(chooseBannerAudience(response({ firstUpload: 'todo', admin }))).toBe('admin');
    expect(
      chooseBannerAudience(response({ firstUpload: 'todo', admin, settings: { adminDismissedAt: '2026-01-01T00:00:00Z' } })),
    ).toBe('user');
  });

  it('dismisses the user checklist from the banner', async () => {
    const { client, write } = fakeClient(response({ firstUpload: 'todo', settings: { welcomeSeenAt: '2026-01-01T00:00:00Z' } }));
    renderShell(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss the getting started checklist' }));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ checklistDismissedAt: expect.any(String) }));
  });
});
