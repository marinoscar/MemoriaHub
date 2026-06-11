import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * Compute the SHA-256 hex digest of a file by streaming it.
 * Does NOT load the entire file into memory.
 */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
