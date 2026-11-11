import type { Transform, Writable } from 'node:stream';

/**
 * The part of the HTTP reply the export streams into (a Fastify reply's `raw` Node response). The
 * slice writes the head itself and pipes chunks, so the response is never buffered.
 *
 * @stability experimental
 */
export interface MediaReply {
  /** Sets the status code (the not-modified / accepted answers of the lifecycle routes). */
  status(statusCode: number): unknown;

  /** The underlying Node response. */
  raw: Writable & {
    /** Writes the status line and headers. */
    writeHead(statusCode: number, headers: Record<string, string>): unknown;
  };
}

/**
 * Injection token of {@link MediaCsvStringifier}.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEDIA_CSV_STRINGIFIER = Symbol.for('@marinoscar/memoriahub/MEDIA_CSV_STRINGIFIER');

/**
 * Builds the streaming RFC 4180 writer the CSV export pipes records through (the host binds
 * `csv-stringify`, so the slice carries no CSV dependency).
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MediaCsvStringifier {
  /**
   * Creates a stringifier that writes a header row and the given columns.
   *
   * @param columns - the column names, in order.
   */
  create(columns: string[]): Transform;
}
