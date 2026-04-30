import { describe, expect, it, vi } from 'vitest';
import {
  CACHE_FILE,
  compareVersions,
  shouldPromptUpdate,
  fetchLatestVersion,
  runUpdateCheck,
} from '../lib/cli/update-check.mjs';

describe('update-check helpers', () => {
  it('compares semver-ish strings numerically', () => {
    expect(compareVersions('0.6.11', '0.6.10')).toBe(1);
    expect(compareVersions('0.6.10', '0.6.11')).toBe(-1);
    expect(compareVersions('0.6.11', '0.6.11')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('v0.6.11', '0.6.11')).toBe(0);
  });

  it('treats prerelease tags as lower than the matching stable version', () => {
    expect(compareVersions('0.6.11', '0.6.11-alpha.1')).toBe(1);
    expect(compareVersions('0.6.11-alpha.1', '0.6.11')).toBe(-1);
  });

  it('only prompts for stable upgrades', () => {
    expect(shouldPromptUpdate('0.6.10', '0.6.11')).toBe(true);
    expect(shouldPromptUpdate('0.6.11', '0.6.11')).toBe(false);
    expect(shouldPromptUpdate('0.6.11', '0.6.10')).toBe(false);
    // Newer pre-releases are skipped — we don't surprise stable users
    // with alpha/beta packages.
    expect(shouldPromptUpdate('0.6.11', '0.7.0-alpha.1')).toBe(false);
    expect(shouldPromptUpdate('', '0.6.12')).toBe(false);
    expect(shouldPromptUpdate('0.6.11', '')).toBe(false);
  });
});

describe('fetchLatestVersion', () => {
  it('returns the version field from a successful registry response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ name: '@acp-kit/spar', version: '0.6.12' }),
    });
    expect(await fetchLatestVersion({ fetchImpl })).toBe('0.6.12');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null on non-ok responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, json: () => ({}) });
    expect(await fetchLatestVersion({ fetchImpl })).toBe(null);
  });

  it('returns null when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENETUNREACH'));
    expect(await fetchLatestVersion({ fetchImpl })).toBe(null);
  });

  it('returns null when fetch is unavailable', async () => {
    expect(await fetchLatestVersion({ fetchImpl: undefined })).toBe(null);
  });
});

const memoryFs = () => {
  const files = new Map();
  return {
    files,
    fs: {
      readFile: async (p) => {
        if (!files.has(p)) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return files.get(p);
      },
      mkdir: async () => {},
      writeFile: async (p, data) => { files.set(p, data); },
    },
  };
};

describe('runUpdateCheck', () => {
  const baseDeps = () => {
    const memory = memoryFs();
    return {
      currentVersion: '0.6.10',
      env: {},
      isTty: true,
      now: 1_700_000_000_000,
      fs: memory.fs,
      _files: memory.files,
      log: () => {},
    };
  };

  it('skips when SPAR_NO_UPDATE_CHECK is set', async () => {
    const deps = baseDeps();
    deps.env = { SPAR_NO_UPDATE_CHECK: '1' };
    const result = await runUpdateCheck({ ...deps, fetchImpl: vi.fn() });
    expect(result).toBe('skipped');
  });

  it('skips when running under CI', async () => {
    const deps = baseDeps();
    deps.env = { CI: 'true' };
    const fetchImpl = vi.fn();
    expect(await runUpdateCheck({ ...deps, fetchImpl })).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips on a non-TTY stdio', async () => {
    const deps = baseDeps();
    deps.isTty = false;
    const fetchImpl = vi.fn();
    expect(await runUpdateCheck({ ...deps, fetchImpl })).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns no-update when the registry version is the same', async () => {
    const deps = baseDeps();
    deps.currentVersion = '0.6.11';
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => ({ version: '0.6.11' }) });
    expect(await runUpdateCheck({ ...deps, fetchImpl, promptImpl: () => Promise.resolve(true), installImpl: () => Promise.resolve(true) })).toBe('no-update');
  });

  it('declines when the user does not press y', async () => {
    const deps = baseDeps();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => ({ version: '0.6.12' }) });
    const promptImpl = vi.fn().mockResolvedValue(false);
    const installImpl = vi.fn().mockResolvedValue(true);
    expect(await runUpdateCheck({ ...deps, fetchImpl, promptImpl, installImpl })).toBe('declined');
    expect(installImpl).not.toHaveBeenCalled();
  });

  it('runs npm install -g when the user accepts', async () => {
    const deps = baseDeps();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => ({ version: '0.6.12' }) });
    const promptImpl = vi.fn().mockResolvedValue(true);
    const installImpl = vi.fn().mockResolvedValue(true);
    const log = vi.fn();
    expect(await runUpdateCheck({ ...deps, fetchImpl, promptImpl, installImpl, log })).toBe('updated');
    expect(installImpl).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalled();
  });

  it('reports install-failed when npm install -g exits non-zero', async () => {
    const deps = baseDeps();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => ({ version: '0.6.12' }) });
    const promptImpl = vi.fn().mockResolvedValue(true);
    const installImpl = vi.fn().mockResolvedValue(false);
    expect(await runUpdateCheck({ ...deps, fetchImpl, promptImpl, installImpl })).toBe('install-failed');
  });

  it('skips network calls when a fresh cache entry exists', async () => {
    const deps = baseDeps();
    deps._files.set(
      CACHE_FILE,
      JSON.stringify({ checkedAt: deps.now - 1000, latest: '0.6.12' }),
    );
    const fetchImpl = vi.fn();
    const promptImpl = vi.fn().mockResolvedValue(false);
    const installImpl = vi.fn();
    const result = await runUpdateCheck({ ...deps, fetchImpl, promptImpl, installImpl });
    expect(result).toBe('declined');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stores the update-check cache under the ACP Kit Spar directory', async () => {
    const deps = baseDeps();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => ({ version: '0.6.12' }) });
    const promptImpl = vi.fn().mockResolvedValue(false);

    await runUpdateCheck({ ...deps, fetchImpl, promptImpl });

    expect(CACHE_FILE).toContain(`${pathSep()}.acp-kit${pathSep()}spar${pathSep()}update-check.json`);
    expect(deps._files.has(CACHE_FILE)).toBe(true);
  });
});

function pathSep() {
  return process.platform === 'win32' ? '\\' : '/';
}
