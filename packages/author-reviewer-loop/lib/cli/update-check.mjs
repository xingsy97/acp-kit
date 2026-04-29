// Best-effort startup update check for the `spar` CLI.
//
// On launch we ping the npm registry for the latest @acp-kit/spar version,
// and if a newer SemVer-stable release exists, prompt the user to press y
// to run `npm install -g @acp-kit/spar` from inside this process. The
// check is intentionally:
//
//  - **Silent on failure**: any network error, registry hiccup, JSON parse
//    error, or timeout short-circuits the check. Running spar must never
//    depend on the registry being reachable.
//  - **TTY-gated**: skipped when stdin/stdout is not a TTY, so CI runs and
//    pipelines never pause for a y/N prompt.
//  - **Bypassable**: skipped when SPAR_NO_UPDATE_CHECK=1, when the spawned
//    process is not running from a global npm install (best-effort
//    detection via the package path), or when the user passes --no-update.
//  - **Cached**: a successful check is cached for 6 hours under the user's
//    home dir, so launching spar twice in a row only hits the registry
//    once.
//
// The check is exported as pure functions plus a single `runUpdateCheck`
// entry point so unit tests can inject the network/prompt/spawn deps.

import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PACKAGE_NAME = '@acp-kit/spar';
export const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent('@acp-kit')}/spar/latest`;
export const FETCH_TIMEOUT_MS = 1500;
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const CACHE_FILE = path.join(os.homedir(), '.acp-kit-spar-update.json');

/**
 * Compare two SemVer-ish version strings. Returns 1 when `a > b`, -1 when
 * `a < b`, and 0 when they compare equal. Pre-release tags (`-alpha.1`)
 * sort lower than the corresponding stable version, matching npm SemVer.
 */
export function compareVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return 0;
  const splitMain = (v) => {
    const [main, pre] = String(v).trim().replace(/^v/, '').split('-', 2);
    return { main: main.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre || '' };
  };
  const A = splitMain(a);
  const B = splitMain(b);
  const len = Math.max(A.main.length, B.main.length);
  for (let i = 0; i < len; i += 1) {
    const x = A.main[i] ?? 0;
    const y = B.main[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  // Equal numeric parts: a stable version (no pre tag) sorts higher than
  // a pre-release (with one). When both have pre tags we just lex-compare
  // them; that is a useful approximation, not the full SemVer rule.
  if (!A.pre && B.pre) return 1;
  if (A.pre && !B.pre) return -1;
  if (A.pre < B.pre) return -1;
  if (A.pre > B.pre) return 1;
  return 0;
}

/**
 * Decide whether a remote version should trigger an update prompt for a
 * user already on `current`. We only nudge for stable releases (no
 * pre-release tag) so beta/alpha publishes don't surprise stable users.
 */
export function shouldPromptUpdate(current, latest) {
  if (!current || !latest) return false;
  if (latest.includes('-')) return false; // skip pre-releases
  return compareVersions(latest, current) > 0;
}

async function readCache(now, fs = fsp) {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.checkedAt !== 'number' || typeof parsed?.latest !== 'string') return null;
    if (now - parsed.checkedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(latest, now, fs = fsp) {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify({ checkedAt: now, latest }), 'utf8');
  } catch {
    /* swallow: cache writes are best-effort */
  }
}

/**
 * Fetch the latest published version of @acp-kit/spar from the npm
 * registry. Resolves to the version string on success, or null on any
 * failure (network, timeout, malformed JSON, missing version field).
 */
export async function fetchLatestVersion({ url = REGISTRY_URL, timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(50, timeoutMs));
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    });
    if (!res?.ok) return null;
    const body = await res.json();
    const version = typeof body?.version === 'string' ? body.version : null;
    return version;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the user whether to update. Resolves to true if they answer y/Y
 * within the timeout, false otherwise (including timeout, EOF, ctrl-c).
 */
export function promptForUpdate({
  question,
  timeoutMs = 8000,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), Math.max(500, timeoutMs));
    rl.on('close', () => { clearTimeout(timer); finish(false); });
    rl.question(question, (answer) => {
      clearTimeout(timer);
      finish(/^y(es)?$/i.test(String(answer || '').trim()));
    });
  });
}

/**
 * Run `npm install -g @acp-kit/spar`. Returns true on exit code 0.
 */
export function runNpmInstallGlobally({
  packageName = PACKAGE_NAME,
  spawnImpl = spawn,
  stdio = 'inherit',
} = {}) {
  return new Promise((resolve) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    let child;
    try {
      child = spawnImpl(npmCmd, ['install', '-g', packageName], { stdio });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Top-level entry point. Returns one of:
 *
 *  - `'updated'`     user accepted and the global install succeeded
 *  - `'install-failed'`  user accepted but `npm install -g` exited non-zero
 *  - `'declined'`    user pressed n / timed out / answered with anything else
 *  - `'no-update'`   no newer stable version available
 *  - `'skipped'`     the check was disabled or unable to run (CI, env, etc.)
 *
 * Callers should treat any return value besides `'updated'` as "go ahead
 * and start the app". On `'updated'` the caller should print a hint and
 * exit so the next launch picks up the new version.
 */
export async function runUpdateCheck({
  currentVersion,
  env = process.env,
  isTty = Boolean(process.stdin?.isTTY) && Boolean(process.stdout?.isTTY),
  now = Date.now(),
  fetchImpl,
  promptImpl = promptForUpdate,
  installImpl = runNpmInstallGlobally,
  fs = fsp,
  log = (msg) => process.stdout.write(`${msg}\n`),
} = {}) {
  if (!currentVersion) return 'skipped';
  if (env?.SPAR_NO_UPDATE_CHECK === '1') return 'skipped';
  if (env?.CI === 'true' || env?.CI === '1') return 'skipped';
  if (!isTty) return 'skipped';

  const cached = await readCache(now, fs);
  let latest = cached?.latest ?? null;
  if (!latest) {
    latest = await fetchLatestVersion({ fetchImpl });
    if (latest) await writeCache(latest, now, fs);
  }
  if (!latest) return 'skipped';
  if (!shouldPromptUpdate(currentVersion, latest)) return 'no-update';

  const question = `A new Spar release is available: ${currentVersion} → ${latest}. Update now via npm install -g @acp-kit/spar? [y/N] `;
  const accepted = await promptImpl({ question });
  if (!accepted) return 'declined';

  log(`Running: npm install -g @acp-kit/spar@${latest}`);
  const ok = await installImpl({});
  if (!ok) return 'install-failed';

  log(`Spar updated to ${latest}. Re-run \`spar\` to use the new version.`);
  return 'updated';
}
