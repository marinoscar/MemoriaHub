/**
 * `/admin/settings/android` — issue #516, epic #498.
 *
 * The service module's API calls are mocked (its pure helpers stay real), and
 * the real AuthContext supplies permissions, so the page, both sections and
 * `useAndroidApp` run as shipped. Covers: the system_settings:write gate, the
 * trusted-key editor (validation mirroring the API, one-click Trust sending the
 * merged list, 400 `details.reason` mapping, the cap), the assetlinks preview,
 * and releases (sidecar auto-fill, upload progress, force retry on
 * RELEASE_VERSION_NOT_NEWER, bump hint on RELEASE_VERSION_EXISTS, rollback
 * confirmation, delete disabled for the current release).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser, mockUser, type MockUser } from '../utils/test-utils';
import { ApiError } from '../../services/api';
import type { AdminRelease, AndroidAppConfig } from '../../services/androidApp';

vi.mock('../../services/androidApp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/androidApp')>();
  return {
    ...actual,
    getAndroidAppConfig: vi.fn(),
    putAndroidAppConfig: vi.fn(),
    listReleases: vi.fn(),
    uploadRelease: vi.fn(),
    makeReleaseCurrent: vi.fn(),
    deleteRelease: vi.fn(),
  };
});

import {
  deleteRelease,
  getAndroidAppConfig,
  listReleases,
  makeReleaseCurrent,
  putAndroidAppConfig,
  uploadRelease,
} from '../../services/androidApp';
import AndroidAppPage from '../../pages/Admin/AndroidAppPage';

const SHA_A = Array.from({ length: 32 }, () => 'AA').join(':');
const SHA_B = Array.from({ length: 32 }, () => 'BB').join(':');
const SHA_C = Array.from({ length: 32 }, () => 'CC').join(':');
const PKG = 'memoriahub.marin.cr';

function assetLinksFor(apps: { packageName: string; sha256: string }[]) {
  return apps.length === 0
    ? []
    : [
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app' as const,
            package_name: apps[0].packageName,
            sha256_cert_fingerprints: apps.map((a) => a.sha256),
          },
        },
      ];
}

function config(overrides: Partial<AndroidAppConfig> = {}): AndroidAppConfig {
  const trustedApps = overrides.trustedApps ?? [{ packageName: PKG, sha256: SHA_A }];
  return {
    trustedApps,
    reportedApps: [
      { packageName: PKG, sha256: SHA_A, deviceCount: 3, lastSeenAt: new Date().toISOString(), trusted: true },
      { packageName: `${PKG}.debug`, sha256: SHA_B, deviceCount: 1, lastSeenAt: null, trusted: false },
    ],
    assetLinks: assetLinksFor(trustedApps),
    ...overrides,
  };
}

function release(overrides: Partial<AdminRelease>): AdminRelease {
  return {
    id: 'r-210',
    packageName: PKG,
    versionName: '2.1.0',
    versionCode: 210,
    fileSha256: 'ab'.repeat(32),
    sizeBytes: String(12 * 1024 * 1024),
    notes: null,
    createdAt: new Date().toISOString(),
    signingSha256: SHA_A,
    isCurrent: false,
    uploadedBy: { id: 'u1', email: 'admin@example.com', displayName: 'Admin User' },
    ...overrides,
  };
}

const CURRENT = release({ id: 'r-210', isCurrent: true, notes: 'Media sync fixes' });
const OLDER = release({ id: 'r-200', versionName: '2.0.0', versionCode: 200 });
const NEWER = release({ id: 'r-220', versionName: '2.2.0', versionCode: 220 });

const readOnlyAdmin: MockUser = {
  ...mockAdminUser,
  permissions: mockAdminUser.permissions.filter((p) => p !== 'system_settings:write'),
};

function renderPage(user: MockUser = mockAdminUser) {
  return render(<AndroidAppPage />, { wrapperOptions: { user } });
}

async function trustedSection() {
  return screen.findByRole('region', { name: 'Trusted signing keys' });
}

async function releasesSection() {
  return screen.findByRole('region', { name: 'Releases' });
}

function apkFile(name = 'memoriahub-android-2.3.0.apk', size = 4) {
  return new File([new Uint8Array(size).fill(0x50)], name, { type: 'application/vnd.android.package-archive' });
}

function sidecarFile(body: Record<string, unknown>, name = 'memoriahub-android-2.3.0.json') {
  const text = JSON.stringify(body);
  const file = new File([text], name, { type: 'application/json' });
  // jsdom's File lacks text() in some versions; the component reads it.
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(text) });
  return file;
}

describe('AndroidAppPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAndroidAppConfig).mockResolvedValue(config());
    vi.mocked(listReleases).mockResolvedValue([NEWER, CURRENT, OLDER]);
    vi.mocked(putAndroidAppConfig).mockImplementation(async (trustedApps) => config({ trustedApps }));
  });

  describe('page shell and RBAC', () => {
    it('renders the shared header, both sections and the current release card', async () => {
      renderPage();

      expect(screen.getByRole('heading', { level: 1, name: 'Android app' })).toBeInTheDocument();
      await releasesSection();
      await trustedSection();
      const current = await screen.findByTestId('current-release');
      expect(within(current).getByText('2.1.0')).toBeInTheDocument();
      expect(within(current).getByText(SHA_A)).toBeInTheDocument();
      expect(within(current).getByText(/uploaded by Admin User/)).toBeInTheDocument();
      expect(within(current).getByText('Media sync fixes')).toBeInTheDocument();
      expect(screen.queryByText(/devices behind/i)).not.toBeInTheDocument();
    });

    it('redirects away without system_settings:read', () => {
      renderPage(mockUser);
      expect(screen.queryByRole('heading', { name: 'Android app' })).not.toBeInTheDocument();
      expect(getAndroidAppConfig).not.toHaveBeenCalled();
    });

    it('disables every write control without system_settings:write', async () => {
      renderPage(readOnlyAdmin);

      expect(screen.getByText(/You can view these settings/)).toBeInTheDocument();
      const trusted = await trustedSection();
      await within(trusted).findByText(`${PKG}.debug`);
      expect(within(trusted).getByRole('button', { name: `Trust ${PKG}.debug` })).toBeDisabled();
      expect(within(trusted).getByRole('button', { name: /Remove memoriahub\.marin\.cr/ })).toBeDisabled();
      expect(within(trusted).getByRole('button', { name: 'Add trusted key' })).toBeDisabled();
      expect(within(trusted).getByLabelText('Package name')).toBeDisabled();

      const releases = await releasesSection();
      await within(releases).findByTestId('release-200');
      expect(within(releases).getByRole('button', { name: 'Make 2.0.0 current' })).toBeDisabled();
      expect(within(releases).getByRole('button', { name: 'Delete 2.0.0' })).toBeDisabled();
      expect(within(releases).getByRole('button', { name: 'Upload release' })).toBeDisabled();
      expect(within(releases).getByRole('button', { name: /Choose APK and sidecar/ })).toBeDisabled();
    });
  });

  describe('trusted signing keys', () => {
    it('one-click Trust PUTs the merged list and marks the signer trusted', async () => {
      const user = userEvent.setup();
      vi.mocked(putAndroidAppConfig).mockResolvedValue(
        config({
          trustedApps: [
            { packageName: PKG, sha256: SHA_A },
            { packageName: `${PKG}.debug`, sha256: SHA_B },
          ],
          reportedApps: config().reportedApps.map((r) => ({ ...r, trusted: true })),
        }),
      );
      renderPage();
      const trusted = await trustedSection();

      await user.click(await within(trusted).findByRole('button', { name: `Trust ${PKG}.debug` }));

      expect(putAndroidAppConfig).toHaveBeenCalledWith([
        { packageName: PKG, sha256: SHA_A },
        { packageName: `${PKG}.debug`, sha256: SHA_B },
      ]);
      const row = await within(trusted).findByTestId(`reported-${PKG}.debug`);
      await waitFor(() => expect(within(row).getByText('Trusted')).toBeInTheDocument());
      expect(within(trusted).getByText(`Trusted ${PKG}.debug.`)).toBeInTheDocument();
    });

    it('shows already-trusted reported signers as trusted, with no Trust button', async () => {
      renderPage();
      const trusted = await trustedSection();
      const row = await within(trusted).findByTestId(`reported-${PKG}`);
      expect(within(row).getByText('Trusted')).toBeInTheDocument();
      expect(within(row).getByText(/3 devices/)).toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: /Trust/ })).not.toBeInTheDocument();
    });

    it('validates the add form like the API before sending anything', async () => {
      const user = userEvent.setup();
      renderPage();
      const trusted = await trustedSection();
      await within(trusted).findByRole('list', { name: 'Trusted signing keys' });

      await user.type(within(trusted).getByLabelText('Package name'), 'notapackage');
      await user.type(within(trusted).getByLabelText('Signing certificate SHA-256'), 'AB:CD');
      await user.click(within(trusted).getByRole('button', { name: 'Add trusted key' }));

      expect(within(trusted).getByText(/Enter an Android package name/)).toBeInTheDocument();
      expect(within(trusted).getByText(/Enter a SHA-256 fingerprint/)).toBeInTheDocument();
      expect(putAndroidAppConfig).not.toHaveBeenCalled();
    });

    it('accepts 64 lowercase hex digits and sends the normalised colon form', async () => {
      const user = userEvent.setup();
      renderPage();
      const trusted = await trustedSection();
      await within(trusted).findByRole('list', { name: 'Trusted signing keys' });

      await user.type(within(trusted).getByLabelText('Package name'), `${PKG}.debug`);
      await user.type(within(trusted).getByLabelText('Signing certificate SHA-256'), 'cc'.repeat(32));
      await user.click(within(trusted).getByRole('button', { name: 'Add trusted key' }));

      expect(putAndroidAppConfig).toHaveBeenCalledWith([
        { packageName: PKG, sha256: SHA_A },
        { packageName: `${PKG}.debug`, sha256: SHA_C },
      ]);
      await waitFor(() => expect(within(trusted).getByLabelText('Package name')).toHaveValue(''));
    });

    it('refuses a duplicate pair client-side', async () => {
      const user = userEvent.setup();
      renderPage();
      const trusted = await trustedSection();
      await within(trusted).findByRole('list', { name: 'Trusted signing keys' });

      await user.type(within(trusted).getByLabelText('Package name'), PKG);
      await user.type(within(trusted).getByLabelText('Signing certificate SHA-256'), SHA_A.toLowerCase());
      await user.click(within(trusted).getByRole('button', { name: 'Add trusted key' }));

      expect(within(trusted).getByText(/already trusted/)).toBeInTheDocument();
      expect(putAndroidAppConfig).not.toHaveBeenCalled();
    });

    it('maps a 400 details.reason to the matching field error', async () => {
      const user = userEvent.setup();
      vi.mocked(putAndroidAppConfig).mockRejectedValue(
        new ApiError('Invalid trusted Android apps', 400, 'BAD_REQUEST', { reason: 'INVALID_FINGERPRINT' }),
      );
      renderPage();
      const trusted = await trustedSection();
      await within(trusted).findByRole('list', { name: 'Trusted signing keys' });

      await user.type(within(trusted).getByLabelText('Package name'), `${PKG}.debug`);
      await user.type(within(trusted).getByLabelText('Signing certificate SHA-256'), SHA_C);
      await user.click(within(trusted).getByRole('button', { name: 'Add trusted key' }));

      expect(await within(trusted).findByText(/Enter a SHA-256 fingerprint/)).toBeInTheDocument();
    });

    it('removes a pair by PUTting the list without it', async () => {
      const user = userEvent.setup();
      renderPage();
      const trusted = await trustedSection();

      await user.click(await within(trusted).findByRole('button', { name: `Remove ${PKG} ${SHA_A}` }));

      expect(putAndroidAppConfig).toHaveBeenCalledWith([]);
    });

    it('disables adding and Trust once ten keys are trusted', async () => {
      const ten = Array.from({ length: 10 }, (_, i) => ({ packageName: `app${i}.example`, sha256: SHA_C }));
      vi.mocked(getAndroidAppConfig).mockResolvedValue(config({ trustedApps: ten }));
      renderPage();
      const trusted = await trustedSection();

      expect(await within(trusted).findByText('Trusted (10/10)')).toBeInTheDocument();
      expect(within(trusted).getByRole('button', { name: 'Add trusted key' })).toBeDisabled();
      expect(within(trusted).getByRole('button', { name: `Trust ${PKG}.debug` })).toBeDisabled();
    });

    it('previews exactly the assetlinks.json the API returned, with a link to it', async () => {
      renderPage();
      const trusted = await trustedSection();
      const preview = await within(trusted).findByTestId('assetlinks-preview');

      expect(JSON.parse(preview.textContent ?? '')).toEqual(config().assetLinks);
      expect(within(trusted).getByRole('link', { name: /assetlinks\.json/ })).toHaveAttribute(
        'href',
        '/.well-known/assetlinks.json',
      );
    });
  });

  describe('releases', () => {
    it('lists releases with the Current chip; delete is disabled for the current release', async () => {
      renderPage();
      const releases = await releasesSection();

      const current = await within(releases).findByTestId('release-210');
      expect(within(current).getByText('Current')).toBeInTheDocument();
      expect(within(current).getByText(/12\.00 MB/)).toBeInTheDocument();
      expect(within(current).queryByRole('button', { name: /Make 2\.1\.0 current/ })).not.toBeInTheDocument();
      expect(within(current).getByRole('button', { name: 'Delete 2.1.0' })).toBeDisabled();
      expect(within(releases).getByRole('button', { name: 'Delete 2.0.0' })).toBeEnabled();
    });

    it('fills the form from the CLI sidecar JSON', async () => {
      const user = userEvent.setup();
      renderPage();
      const releases = await releasesSection();
      await within(releases).findByTestId('release-210');

      await user.upload(screen.getByTestId('release-file-input'), [
        apkFile(),
        sidecarFile({
          packageName: `${PKG}.debug`,
          versionName: '2.3.0',
          versionCode: 230,
          signingSha256: 'cc'.repeat(32),
          sizeBytes: 4,
        }),
      ]);

      const form = screen.getByRole('form', { name: 'Upload a release' });
      await waitFor(() => expect(within(form).getByLabelText('Version name')).toHaveValue('2.3.0'));
      expect(within(form).getByLabelText('Version code')).toHaveValue('230');
      expect(within(form).getByLabelText('Package name')).toHaveValue(`${PKG}.debug`);
      expect(within(form).getByLabelText('Signing certificate SHA-256')).toHaveValue(SHA_C);
      expect(within(form).getByText(/Filled in from memoriahub-android-2\.3\.0\.json/)).toBeInTheDocument();
      expect(within(form).queryByTestId('sidecar-size-mismatch')).not.toBeInTheDocument();
    });

    it('warns when the APK size does not match the sidecar', async () => {
      const user = userEvent.setup();
      renderPage();
      await within(await releasesSection()).findByTestId('release-210');

      await user.upload(screen.getByTestId('release-file-input'), [
        apkFile('memoriahub-android-2.3.0.apk', 8),
        sidecarFile({ versionName: '2.3.0', versionCode: 230, sizeBytes: 4 }),
      ]);

      expect(await screen.findByTestId('sidecar-size-mismatch')).toBeInTheDocument();
    });

    it('uploads with the form fields, shows progress, and defaults signer and package', async () => {
      const user = userEvent.setup();
      let finish: (r: AdminRelease) => void = () => {};
      vi.mocked(uploadRelease).mockImplementation((_input, onProgress) => {
        onProgress?.({ loaded: 2, total: 4 });
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      renderPage();
      const releases = await releasesSection();
      await within(releases).findByTestId('release-210');
      const form = screen.getByRole('form', { name: 'Upload a release' });

      await user.upload(screen.getByTestId('release-file-input'), apkFile());
      await user.type(within(form).getByLabelText('Version name'), '2.3.0');
      await user.type(within(form).getByLabelText('Version code'), '230');
      await user.type(within(form).getByLabelText('Release notes'), 'Faster sync');
      await user.click(within(form).getByRole('button', { name: 'Upload release' }));

      expect(await within(form).findByText('Uploading… 50%')).toBeInTheDocument();
      expect(uploadRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          packageName: PKG,
          versionName: '2.3.0',
          versionCode: 230,
          signingSha256: SHA_A,
          notes: 'Faster sync',
          makeCurrent: true,
          force: false,
        }),
        expect.any(Function),
      );

      await act(async () => finish(release({ id: 'r-230', versionName: '2.3.0', versionCode: 230, isCurrent: true })));
      expect(await within(releases).findByText(/Uploaded 2\.3\.0 \(230\) and made it the current release\./)).toBeInTheDocument();
      // Becoming current trusts the signer server-side, so the config is re-read.
      await waitFor(() => expect(getAndroidAppConfig).toHaveBeenCalledTimes(2));
    });

    it('validates before uploading', async () => {
      const user = userEvent.setup();
      renderPage();
      const releases = await releasesSection();
      await within(releases).findByTestId('release-210');
      const form = screen.getByRole('form', { name: 'Upload a release' });

      await user.type(within(form).getByLabelText('Version name'), '-bad');
      await user.type(within(form).getByLabelText('Version code'), '0');
      await user.click(within(form).getByRole('button', { name: 'Upload release' }));

      expect(within(form).getByText('Choose the APK file.')).toBeInTheDocument();
      expect(within(form).getByText(/Letters, digits/)).toBeInTheDocument();
      expect(within(form).getByText(/A whole number from 1 to/)).toBeInTheDocument();
      expect(uploadRelease).not.toHaveBeenCalled();
    });

    it('offers a force retry on RELEASE_VERSION_NOT_NEWER and resends with force', async () => {
      const user = userEvent.setup();
      vi.mocked(uploadRelease)
        .mockRejectedValueOnce(
          new ApiError('not newer', 409, 'CONFLICT', {
            reason: 'RELEASE_VERSION_NOT_NEWER',
            currentVersionCode: 210,
          }),
        )
        .mockResolvedValueOnce(release({ id: 'r-205', versionName: '2.0.5', versionCode: 205, isCurrent: true }));
      renderPage();
      await within(await releasesSection()).findByTestId('release-210');
      const form = screen.getByRole('form', { name: 'Upload a release' });

      await user.upload(screen.getByTestId('release-file-input'), apkFile());
      await user.type(within(form).getByLabelText('Version name'), '2.0.5');
      await user.type(within(form).getByLabelText('Version code'), '205');
      await user.click(within(form).getByRole('button', { name: 'Upload release' }));

      const warning = await within(form).findByTestId('upload-not-newer');
      await user.click(within(warning).getByRole('button', { name: 'Upload anyway (force)' }));

      await waitFor(() => expect(uploadRelease).toHaveBeenCalledTimes(2));
      expect(vi.mocked(uploadRelease).mock.calls[0][0].force).toBe(false);
      expect(vi.mocked(uploadRelease).mock.calls[1][0]).toEqual(
        expect.objectContaining({ force: true, versionCode: 205 }),
      );
    });

    it('shows a bump hint on RELEASE_VERSION_EXISTS', async () => {
      const user = userEvent.setup();
      vi.mocked(uploadRelease).mockRejectedValue(
        new ApiError('exists', 409, 'CONFLICT', { reason: 'RELEASE_VERSION_EXISTS' }),
      );
      renderPage();
      await within(await releasesSection()).findByTestId('release-210');
      const form = screen.getByRole('form', { name: 'Upload a release' });

      await user.upload(screen.getByTestId('release-file-input'), apkFile());
      await user.type(within(form).getByLabelText('Version name'), '2.1.0');
      await user.type(within(form).getByLabelText('Version code'), '210');
      await user.click(within(form).getByRole('button', { name: 'Upload release' }));

      const hint = await within(form).findByTestId('upload-version-exists');
      expect(within(hint).getByText('memoriahub android version --bump patch')).toBeInTheDocument();
      expect(within(form).queryByTestId('upload-not-newer')).not.toBeInTheDocument();
    });

    it('asks before rolling back to a lower version code', async () => {
      const user = userEvent.setup();
      vi.mocked(makeReleaseCurrent).mockResolvedValue({ ...OLDER, isCurrent: true });
      renderPage();
      const releases = await releasesSection();

      await user.click(await within(releases).findByRole('button', { name: 'Make 2.0.0 current' }));

      const dialog = await screen.findByRole('dialog', { name: 'Roll back to 2.0.0?' });
      expect(
        within(dialog).getByText(/Phones on 2\.1\.0 will not downgrade automatically; users must reinstall/),
      ).toBeInTheDocument();
      expect(makeReleaseCurrent).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Roll back' }));
      await waitFor(() => expect(makeReleaseCurrent).toHaveBeenCalledWith('r-200'));
    });

    it('cancelling the rollback leaves the current release alone', async () => {
      const user = userEvent.setup();
      renderPage();
      const releases = await releasesSection();

      await user.click(await within(releases).findByRole('button', { name: 'Make 2.0.0 current' }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

      expect(makeReleaseCurrent).not.toHaveBeenCalled();
    });

    it('makes a newer release current without a rollback prompt', async () => {
      const user = userEvent.setup();
      vi.mocked(makeReleaseCurrent).mockResolvedValue({ ...NEWER, isCurrent: true });
      renderPage();
      const releases = await releasesSection();

      await user.click(await within(releases).findByRole('button', { name: 'Make 2.2.0 current' }));

      await waitFor(() => expect(makeReleaseCurrent).toHaveBeenCalledWith('r-220'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('deletes a non-current release only after confirmation', async () => {
      const user = userEvent.setup();
      vi.mocked(deleteRelease).mockResolvedValue(undefined);
      renderPage();
      const releases = await releasesSection();

      await user.click(await within(releases).findByRole('button', { name: 'Delete 2.0.0' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete 2.0.0?' });
      expect(deleteRelease).not.toHaveBeenCalled();
      await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => expect(deleteRelease).toHaveBeenCalledWith('r-200'));
      expect(await within(releases).findByText('Deleted 2.0.0.')).toBeInTheDocument();
    });
  });
});
