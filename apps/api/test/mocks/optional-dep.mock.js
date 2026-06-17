/**
 * Stub for optional Docker-only packages (@aws-sdk/*, @tensorflow/*, @vladmandic/*)
 * that are not installed in the local dev environment.
 *
 * Referenced by Jest moduleNameMapper so that any import of these packages
 * resolves to a no-op stub instead of throwing "Cannot find module".
 * Individual spec files that need real behaviour should use jest.mock() to
 * override specific exports before importing the module under test.
 */
module.exports = new Proxy(
  {},
  {
    get(_target, prop) {
      // Return a jest-friendly no-op constructor/function for anything accessed
      if (prop === '__esModule') return true;
      return function MockOptionalDepExport() {};
    },
  },
);
