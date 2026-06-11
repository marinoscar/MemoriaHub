import { Command } from 'commander';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import chalk from 'chalk';
import { saveConfig } from '../config.js';
import { ApiClient, ApiError } from '../api.js';
import { ui, createSpinner, printBox } from '../ui.js';

export function loginCommand(): Command {
  const cmd = new Command('login');
  cmd.description(
    'Authenticate with a MemoriaHub server using a Personal Access Token (PAT)',
  );

  cmd.action(async () => {
    const rl = readline.createInterface({ input, output });
    try {
      ui.step('Login to MemoriaHub');
      ui.blank();

      const serverUrl = await rl.question(chalk.cyan('  Server URL (e.g. https://example.com): '));
      if (!serverUrl.trim()) {
        ui.error('Server URL cannot be empty.');
        process.exit(1);
      }

      // Do not accept PAT as positional arg — always prompt interactively
      const pat = await rl.question(chalk.cyan('  Personal Access Token: '));
      if (!pat.trim()) {
        ui.error('PAT cannot be empty.');
        process.exit(1);
      }

      ui.blank();
      const spinner = createSpinner('Validating token with server…');
      spinner.start();

      const api = new ApiClient({ serverUrl: serverUrl.trim(), pat: pat.trim() });

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

      saveConfig({ serverUrl: serverUrl.trim(), pat: pat.trim() });

      printBox(
        [
          chalk.bold(`Logged in as ${chalk.cyan(userEmail)}`),
          '',
          `  Server : ${serverUrl.trim()}`,
          `  Config : ${chalk.dim('~/.memoriahub/config.json')}`,
          '',
          chalk.dim('Run `memoriahub import <folder>` to start uploading.'),
        ],
        'Login Successful',
      );
    } finally {
      rl.close();
    }
  });

  return cmd;
}
