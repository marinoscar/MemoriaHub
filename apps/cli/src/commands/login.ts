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
import chalk from 'chalk';
import { saveConfig } from '../config.js';
import { ApiClient, ApiError } from '../api.js';
import { ui, createSpinner, printBox } from '../ui.js';
import { type DeviceTokenResult } from '../device-auth.js';
import { runDeviceLogin } from '../device-login.js';

// ---------------------------------------------------------------------------
// Shared helper: validate PAT and save config
// ---------------------------------------------------------------------------

async function validateAndSave(
  serverUrl: string,
  pat: string,
  label: string,
  patExpiresAt?: string,
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

  saveConfig({ serverUrl, pat, patExpiresAt });

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

      // Run the shared interactive device-authorization flow. It owns the
      // spinner/instruction UI and fails the spinner with a message on error;
      // we just translate a thrown error into a non-zero exit here.
      let tokenResult: DeviceTokenResult;
      try {
        tokenResult = await runDeviceLogin(serverUrl);
      } catch {
        process.exit(1);
      }

      // Validate token and save (include expiry for pre-flight warnings)
      await validateAndSave(serverUrl, tokenResult.accessToken, 'Verifying token', tokenResult.expiresAt);
    } finally {
      rl.close();
    }
  });

  return cmd;
}
