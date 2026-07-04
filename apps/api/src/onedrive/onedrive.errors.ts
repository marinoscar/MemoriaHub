/**
 * Thrown when a Microsoft refresh-token grant fails with `invalid_grant`
 * (revoked consent or an expired/invalidated refresh token). Callers should
 * surface this to the user as "OneDrive connection expired — please reconnect"
 * rather than retrying indefinitely. See docs/specs/onedrive-import.md §2, §9.
 */
export class OneDriveConnectionExpiredError extends Error {
  constructor(message = 'OneDrive connection expired — please reconnect') {
    super(message);
    this.name = 'OneDriveConnectionExpiredError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an operation requires a OneDrive connection but the caller has
 * none (never connected, or disconnected).
 */
export class OneDriveNotConnectedError extends Error {
  constructor(message = 'No OneDrive connection found for this user') {
    super(message);
    this.name = 'OneDriveNotConnectedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
