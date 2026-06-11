/**
 * login.ts — Authenticate with a MemoriaHub server.
 *
 * Default (device flow):
 *   1. Prompt for Server URL (or take --server flag).
 *   2. POST /api/auth/device/code with clientInfo.tokenType='pat'.
 *   3. Show userCode + verificationUri; best-effort open browser.
 *   4. Poll /api/auth/device/token until approved → receive 90-day PAT.
 *   5. Validate via GET /api/auth/me; save config.
 *
 * Headless / CI fallback (--token <pat>):
 *   Validate the provided PAT against the server; save config.
 *   Requires --server or prompts for URL.
 *
 * Config file shape is unchanged: { serverUrl, pat } so all other commands
 * (import, sync, etc.) keep working without modification.
 */

import { Command } from 'commander';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { execFile } from 'child_process';
import * as os from 'os';
import chalk from 'chalk';
import { saveConfig } from '../config.js';
import { ApiClient, ApiError } from '../api.js';
import { ui, createSpinner, printBox } from '../ui.js';
import { requestDeviceCode, pollForDeviceToken } from '../device-auth.js';

// ---------------------------------------------------------------------------
// Browser opener — platform-specific, no npm dependency
// ---------------------------------------------------------------------------

/**
 * Best-effort open a URL in the default browser.
 * Silently swallows all errors — the URL is always printed in the UI.
 */
function openBrowser(url: string): void {
  const platform = os.platform();
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    // `cmd /c start` handles spaces and special chars correctly
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    // Linux / other POSIX
    cmd = 'xdg-open';
    args = [url];
  }

  try {
    execFile(cmd, args, { timeout: 5000 }, () => {
      // ignore all errors and exit codes
    });
  } catch {
    // ignore synchronous errors (e.g. ENOENT on minimal systems)
  }
}

// ---------------------------------------------------------------------------
// Shared helper: validate PAT and save config
// ---------------------------------------------------------------------------

async function validateAndSave(
  serverUrl: string,
  pat: string,
  label: string,
): Promise<void> {
  const spinner = createSpinner(`${label}…`);
  spinner.start();

  const api = new ApiClient({ serverUrl, pat });

  let userEmail: string;
  try {
    const me = await api.get<{ email: string }>('/api/auth/me');
    userEmail = me.email;
  } catch (err) {
    if (err instanceof ApiError) {
      spinner.fail(
        `Authentication failed (HTTP ${err.status}): ${err.serverMessage}`,
      );
    } else {
      spinner.fail(
        `Could not reach server: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    process.exit(1);
  }

  spinner.succeed('Token validated');

  saveConfig({ serverUrl, pat });

  printBox(
    [
      chalk.bold(`Logged in as ${chalk.cyan(userEmail)}`),
      '',
      `  Server : ${serverUrl}`,
      `  Config : ${chalk.dim('~/.memoriahub/config.json')}`,
      '',
      chalk.dim(
        'This device\'s token is valid for ~90 days (managed under Personal\n' +
        '  Access Tokens in the web app; revoke anytime).',
      ),
    ],
    'Login Successful',
  );
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function loginCommand(): Command {
  const cmd = new Command('login');
  cmd
    .description('Authenticate with a MemoriaHub server')
    .option('--server <url>', 'Server URL (skips interactive prompt)')
    .option(
      '--token <pat>',
      'Use an existing Personal Access Token (CI/headless fallback)',
    );

  cmd.action(async (opts: { server?: string; token?: string }) => {
    const rl = readline.createInterface({ input, output });

    try {
      // ------------------------------------------------------------------
      // Determine Server URL
      // ------------------------------------------------------------------
      let serverUrl = opts.server?.trim() ?? '';
      if (!serverUrl) {
        ui.step('Login to MemoriaHub');
        ui.blank();
        serverUrl = (
          await rl.question(chalk.cyan('  Server URL (e.g. https://example.com): '))
        ).trim();
      }
      if (!serverUrl) {
        ui.error('Server URL cannot be empty.');
        process.exit(1);
      }

      // ------------------------------------------------------------------
      // Headless / CI path: --token <pat>
      // ------------------------------------------------------------------
      if (opts.token) {
        const pat = opts.token.trim();
        if (!pat) {
          ui.error('--token value cannot be empty.');
          process.exit(1);
        }
        ui.blank();
        await validateAndSave(serverUrl, pat, 'Validating token with server');
        return;
      }

      // ------------------------------------------------------------------
      // Device flow (default)
      // ------------------------------------------------------------------
      ui.step('Login to MemoriaHub');
      ui.blank();

      // Step 1: Request device code
      const codeSpinner = createSpinner('Requesting authorization code…');
      codeSpinner.start();

      let codeResp;
      try {
        codeResp = await requestDeviceCode(serverUrl, {
          tokenType: 'pat',
          name: 'MemoriaHub CLI',
          hostname: os.hostname(),
          platform: os.platform(),
        });
      } catch (err) {
        codeSpinner.fail(
          `Failed to request device code: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }

      codeSpinner.succeed('Authorization code issued');

      const { deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval } =
        codeResp;

      // Step 2: Show instructions
      ui.blank();
      printBox(
        [
          chalk.bold('To authorize this device, open the URL below in your browser:'),
          '',
          `  ${chalk.cyan(verificationUri)}`,
          '',
          `  Then enter the code: ${chalk.bold(chalk.yellow(userCode))}`,
          '',
          chalk.dim(`(Or open the direct link: ${verificationUriComplete})`),
          '',
          chalk.dim(
            `This code expires in ${Math.round(expiresIn / 60)} minutes.`,
          ),
        ],
        'Device Authorization',
      );

      // Step 3: Best-effort browser open
      ui.dim(`Opening browser to: ${verificationUriComplete}`);
      openBrowser(verificationUriComplete);

      // Step 4: Poll for approval
      const pollSpinner = createSpinner('Waiting for authorization in browser…');
      pollSpinner.start();

      let accessToken: string;
      try {
        accessToken = await pollForDeviceToken(
          serverUrl,
          deviceCode,
          interval,
          expiresIn,
          (state) => {
            if (state === 'slow_down') {
              pollSpinner.text = 'Waiting for authorization… (server asked to slow down)';
            }
          },
        );
      } catch (err) {
        pollSpinner.fail(
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }

      pollSpinner.succeed('Device authorized');

      // Step 5: Validate token and save
      await validateAndSave(serverUrl, accessToken, 'Verifying token');
    } finally {
      rl.close();
    }
  });

  return cmd;
}
