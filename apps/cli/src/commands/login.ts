import { Command } from 'commander';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { saveConfig } from '../config';
import { ApiClient, ApiError } from '../api';

export function loginCommand(): Command {
  const cmd = new Command('login');
  cmd.description(
    'Authenticate with a MemoriaHub server using a Personal Access Token (PAT)',
  );

  cmd.action(async () => {
    const rl = readline.createInterface({ input, output });
    try {
      const serverUrl = await rl.question('Server URL (e.g. https://example.com): ');
      if (!serverUrl.trim()) {
        console.error('Server URL cannot be empty.');
        process.exit(1);
      }

      // Do not accept PAT as positional arg — always prompt interactively
      const pat = await rl.question('Personal Access Token: ');
      if (!pat.trim()) {
        console.error('PAT cannot be empty.');
        process.exit(1);
      }

      const api = new ApiClient({ serverUrl: serverUrl.trim(), pat: pat.trim() });

      let userEmail: string;
      try {
        const me = await api.get<{ email: string }>('/api/auth/me');
        userEmail = me.email;
      } catch (err) {
        if (err instanceof ApiError) {
          console.error(
            `Authentication failed (HTTP ${err.status}): ${err.serverMessage}`,
          );
        } else {
          console.error(
            `Could not reach server: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        process.exit(1);
      }

      saveConfig({ serverUrl: serverUrl.trim(), pat: pat.trim() });
      console.log(`\nLogged in as ${userEmail}. Config saved to ~/.memoriahub/config.json`);
    } finally {
      rl.close();
    }
  });

  return cmd;
}
