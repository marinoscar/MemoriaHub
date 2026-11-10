/**
 * The base of a domain error that carries a machine-readable reason. A slice throws a subclass for a
 * business refusal; the host's error filter turns it into the error envelope with `details.reason`
 * (the `code` is derived from the HTTP status, never set here).
 *
 * @stability experimental
 */
export class MemoriahubError extends Error {
  /** The machine-readable reason a client keys off (`UPLOAD_PARTS_MISSING`). */
  readonly reason: string;

  /** Extra scalar fields the response carries under `details`. */
  readonly details: Readonly<Record<string, unknown>>;

  /**
   * @param reason - the machine-readable reason.
   * @param message - a sentence for the log and the user.
   * @param details - extra fields, reported under `details` (never at the top level of the body).
   */
  constructor(reason: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.reason = reason;
    this.details = Object.freeze({ ...details });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a feature is switched off (a feature flag or its kill switch). The host maps it to a
 * 400 or 404 as the route's contract says; it never leaks which of the two layers said no.
 *
 * @stability experimental
 */
export class MemoriahubFeatureDisabledError extends MemoriahubError {
  /**
   * @param feature - the feature flag name (`pictureEnhancement`).
   */
  constructor(feature: string) {
    super('FEATURE_DISABLED', `The feature "${feature}" is disabled`, { feature });
  }
}
