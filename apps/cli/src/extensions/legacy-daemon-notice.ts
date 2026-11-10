/**
 * extensions/legacy-daemon-notice.ts - a 1.3 worker daemon left running across the upgrade
 * (RETRO-C10, #616).
 *
 * 1.3 kept `node.pid` and `node.sock` directly in `~/.memoriahub`; the platform keeps them in
 * `~/.memoriahub/node/`. A daemon started by 1.3 is therefore invisible to the new `node status` and
 * `node stop`, and would keep claiming nothing (the platform API refuses its protocol) while holding
 * the node name. The notice names the process; stale files of a dead one are removed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * @param dir - The 1.3 state directory; defaults to `~/.memoriahub`.
 * @returns the line to print, or `undefined` when there is nothing to say.
 */
export function legacyDaemonNotice(dir: string = path.join(os.homedir(), '.memoriahub')): string | undefined {
  const pidFile = path.join(dir, 'node.pid');
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  } catch {
    return undefined;
  }
  if (Number.isFinite(pid) && pid > 0 && alive(pid)) {
    return (
      `memoriahub: a worker started by CLI 1.3 is still running (pid ${pid}). It cannot claim jobs on this server; ` +
      `stop it with \`kill ${pid}\`, then run \`memoriahub node start --daemon\`.`
    );
  }
  for (const stale of ['node.pid', 'node.sock']) {
    try {
      fs.unlinkSync(path.join(dir, stale));
    } catch {
      /* already gone */
    }
  }
  return undefined;
}
