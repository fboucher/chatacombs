import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * The running app version. package.json is the source of truth; a Docker image
 * built by the release workflow sets APP_VERSION to the GitHub release tag.
 */
export const VERSION = process.env.APP_VERSION || pkg.version;
