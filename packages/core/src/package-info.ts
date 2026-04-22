// Reports `name` and `version` from the package.json that ships with this build,
// so ACP `initialize.clientInfo` always matches the installed package without
// needing to remember to bump a hardcoded constant alongside the version field.
//
// Implementation note: tsc's `rootDir` excludes `package.json`, so we read it at
// runtime via `node:fs` instead of `import` syntax. The relative path resolves
// to `<package-root>/package.json` both in `dist/` (shipped to npm) and in
// `src/` (when the consumer is using the repo via tsconfig paths).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

interface PackageInfo {
  readonly name: string;
  readonly version: string;
}

function loadPackageInfo(): PackageInfo {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/package-info.js → ../package.json
    // src/package-info.ts  → ../package.json
    const pkgPath = resolve(here, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '@acp-kit/core',
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    };
  } catch {
    // Browser/webpack/Vite bundles often shake out node:fs; fall back to defaults
    // so the `initialize` handshake still succeeds.
    return { name: '@acp-kit/core', version: '0.0.0' };
  }
}

const info = loadPackageInfo();

export const CORE_PACKAGE_NAME: string = info.name;
export const CORE_PACKAGE_VERSION: string = info.version;
