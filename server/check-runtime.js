/**
 * Mindestversionen mit dem Brotli-Fix fuer CVE-2026-111497.
 * https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
 * Vor den uebrigen App-Imports ausfuehren: npm engines warnt nur und schuetzt
 * einen direkten Aufruf von `node server/index.js` nicht.
 */

export const SUPPORTED_NODE_VERSIONS = '^22.23.4 || ^24.22.1 || >=26.12.1';

export function assertSupportedNodeVersion(version = process.versions.node) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match) {
    const [major, minor, patch] = match.slice(1).map(Number);
    const minimum = { 22: [23, 4], 24: [22, 1], 26: [12, 1] }[major];
    if (major > 26 || (minimum
      && (minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1])))) {
      return;
    }
  }
  throw new Error(
    `Unsupported Node.js ${version}. Yuvomi requires ${SUPPORTED_NODE_VERSIONS} `
    + 'with the Brotli security fix for CVE-2026-111497. Upgrade Node.js and restart Yuvomi.',
  );
}

assertSupportedNodeVersion();
