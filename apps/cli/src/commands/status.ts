import { Command } from 'commander';
import { loadAllManifests } from '../manifest';

export function statusCommand(): Command {
  const cmd = new Command('status');
  cmd.description('Show sync status for all configured folders');

  cmd.action(() => {
    const manifests = loadAllManifests();

    if (manifests.length === 0) {
      console.log(
        'No sync history found. Run `memoriahub import <folder>` or `memoriahub sync <folder>` first.',
      );
      return;
    }

    console.log('');
    for (const m of manifests) {
      const entries = Object.values(m.files);
      const uploaded = entries.filter((e) => e.status === 'uploaded').length;
      const failed = entries.filter((e) => e.status === 'failed').length;
      const pending = entries.filter((e) => e.status === 'pending').length;
      const total = entries.length;

      const lastSync = m.lastSyncAt
        ? new Date(m.lastSyncAt).toLocaleString()
        : 'never';

      console.log(`Folder    : ${m.folderPath}`);
      console.log(`Last sync : ${lastSync}`);
      console.log(
        `Files     : ${total} total  |  ${uploaded} uploaded  |  ${pending} pending  |  ${failed} failed`,
      );
      console.log('');
    }
  });

  return cmd;
}
