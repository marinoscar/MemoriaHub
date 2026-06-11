import { Command } from 'commander';
import { loadAllManifests } from '../manifest.js';
import { ui, printFolderStatusTable, FolderStatusRow } from '../ui.js';

export function statusCommand(): Command {
  const cmd = new Command('status');
  cmd.description('Show sync status for all configured folders');

  cmd.action(() => {
    const manifests = loadAllManifests();

    if (manifests.length === 0) {
      ui.info(
        'No sync history found. Run `memoriahub import <folder>` or `memoriahub sync <folder>` first.',
      );
      return;
    }

    const rows: FolderStatusRow[] = manifests.map((m) => {
      const entries = Object.values(m.files);
      const uploaded = entries.filter((e) => e.status === 'uploaded').length;
      const failed   = entries.filter((e) => e.status === 'failed').length;
      const pending  = entries.filter((e) => e.status === 'pending').length;
      const total    = entries.length;
      const lastSync = m.lastSyncAt
        ? new Date(m.lastSyncAt).toLocaleString()
        : 'never';

      return { folder: m.folderPath, lastSync, uploaded, pending, failed, total };
    });

    ui.blank();
    ui.step('Sync Status');
    ui.blank();
    printFolderStatusTable(rows);
  });

  return cmd;
}
