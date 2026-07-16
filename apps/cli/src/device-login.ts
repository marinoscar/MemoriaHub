/**
 * device-login.ts — Interactive RFC 8628 device-flow login.
 *
 * Extracted from `commands/login.ts` so both `memoriahub login` and
 * `memoriahub node enroll` share one implementation of the request-code →
 * show-instructions → open-browser → poll sequence instead of duplicating the
 * polling logic.
 *
 * Owns the interactive UI (spinner, instruction box, browser open) and returns
 * the issued token on success. On failure it fails the spinner with a
 * human-readable message and re-throws — the caller decides how to exit.
 */

import * as os from 'os';
import chalk from 'chalk';
import { ui, createSpinner, printBox } from './ui.js';
import { requestDeviceCode, pollForDeviceToken, type DeviceTokenResult } from './device-auth.js';
import { openBrowser } from './open-browser.js';

/**
 * Run the interactive device-authorization flow against `serverUrl` and return
 * the issued token. `clientName` is the human-friendly label shown for the
 * issued token server-side (Personal Access Tokens list).
 *
 * @throws when the device code cannot be requested or authorization fails /
 *         times out. The relevant spinner has already been failed with a
 *         message by the time this throws.
 */
export async function runDeviceLogin(
  serverUrl: string,
  clientName = 'MemoriaHub CLI',
): Promise<DeviceTokenResult> {
  // Step 1: Request device code
  const codeSpinner = createSpinner('Requesting authorization code…');
  codeSpinner.start();

  let codeResp;
  try {
    codeResp = await requestDeviceCode(serverUrl, {
      tokenType: 'pat',
      name: clientName,
      hostname: os.hostname(),
      platform: os.platform(),
    });
  } catch (err) {
    codeSpinner.fail(
      `Failed to request device code: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
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
      chalk.dim(`This code expires in ${Math.round(expiresIn / 60)} minutes.`),
    ],
    'Device Authorization',
  );

  // Step 3: Best-effort browser open
  ui.dim(`Opening browser to: ${verificationUriComplete}`);
  openBrowser(verificationUriComplete);

  // Step 4: Poll for approval
  const pollSpinner = createSpinner('Waiting for authorization in browser…');
  pollSpinner.start();

  let tokenResult: DeviceTokenResult;
  try {
    tokenResult = await pollForDeviceToken(serverUrl, deviceCode, interval, expiresIn, (state) => {
      if (state === 'slow_down') {
        pollSpinner.text = 'Waiting for authorization… (server asked to slow down)';
      }
    });
  } catch (err) {
    pollSpinner.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }

  pollSpinner.succeed('Device authorized');
  return tokenResult;
}
