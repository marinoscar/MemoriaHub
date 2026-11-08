// Product identity constants, all derived from identity.json (the single source of truth).
// Plain JavaScript with a hand-written .d.ts on purpose: nothing to build, so apps/api's
// rootDir, Jest and CI keep working unchanged when they import this workspace package.
const identity = require('./identity.json');

exports.IDENTITY = identity;
exports.PRODUCT_NAME = identity.productName;
exports.TAGLINE = identity.tagline;
exports.THEME_COLOR = identity.themeColor;
exports.BACKGROUND_COLOR = identity.backgroundColor;
exports.CLI_NAME = identity.cliName;
exports.REPO_SLUG = identity.repoSlug;
// Lowercase hyphenated token for service names, file prefixes, project names.
exports.APP_SLUG = identity.cliName;
