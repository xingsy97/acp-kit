import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { clearCommandResolutionCache, resolveCommandOnPath } from '../src/command-exists.js';

const createdDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-command-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  clearCommandResolutionCache({ cacheFile: path.join(os.tmpdir(), 'acp-command-cache-test.json') });
});

describe('resolveCommandOnPath', () => {
  it('resolves Windows PATHEXT shims to their concrete .cmd path', () => {
    const dir = tempDir();
    const extensionlessShim = path.join(dir, 'copilot-language-server');
    const shim = path.join(dir, 'copilot-language-server.cmd');
    fs.writeFileSync(extensionlessShim, '#!/usr/bin/env node\r\n', 'utf8');
    fs.writeFileSync(shim, '@echo off\r\n', 'utf8');

    expect(resolveCommandOnPath('copilot-language-server', {
      platform: 'win32',
      pathEnv: dir,
      pathext: '.COM;.EXE;.BAT;.CMD',
    })).toBe(shim);
  });

  it('resolves Windows PowerShell shims even when PATHEXT omits .PS1', () => {
    const dir = tempDir();
    const shim = path.join(dir, 'codex.ps1');
    fs.writeFileSync(shim, 'Write-Output codex\r\n', 'utf8');

    expect(resolveCommandOnPath('codex', {
      platform: 'win32',
      pathEnv: dir,
      pathext: '.COM;.EXE;.BAT;.CMD',
    })).toBe(shim);
  });

  it('returns null for missing commands', () => {
    expect(resolveCommandOnPath('acp-kit-definitely-missing', {
      platform: 'win32',
      pathEnv: '',
    })).toBeNull();
  });

  it('reuses cached misses until the TTL expires', () => {
    const dir = tempDir();
    const cacheFile = path.join(os.tmpdir(), 'acp-command-cache-test.json');
    const command = 'cached-miss';
    const firstNow = Date.now();

    expect(resolveCommandOnPath(command, {
      platform: 'win32',
      pathEnv: dir,
      cacheFile,
      cacheTtlMs: 10_000,
      now: firstNow,
    })).toBeNull();

    fs.writeFileSync(path.join(dir, `${command}.cmd`), '@echo off\r\n', 'utf8');

    expect(resolveCommandOnPath(command, {
      platform: 'win32',
      pathEnv: dir,
      cacheFile,
      cacheTtlMs: 10_000,
      now: firstNow + 100,
    })).toBeNull();

    expect(resolveCommandOnPath(command, {
      platform: 'win32',
      pathEnv: dir,
      cacheFile,
      cacheTtlMs: 10_000,
      now: firstNow + 20_000,
    })).toBe(path.join(dir, `${command}.cmd`));
  });

  it('invalidates cached positive hits when the resolved file disappears', () => {
    const dir = tempDir();
    const cacheFile = path.join(os.tmpdir(), 'acp-command-cache-test.json');
    const command = 'cached-hit';
    const shim = path.join(dir, `${command}.cmd`);
    const firstNow = Date.now();
    fs.writeFileSync(shim, '@echo off\r\n', 'utf8');

    expect(resolveCommandOnPath(command, {
      platform: 'win32',
      pathEnv: dir,
      cacheFile,
      cacheTtlMs: 10_000,
      now: firstNow,
    })).toBe(shim);

    fs.rmSync(shim);

    expect(resolveCommandOnPath(command, {
      platform: 'win32',
      pathEnv: dir,
      cacheFile,
      cacheTtlMs: 10_000,
      now: firstNow + 100,
    })).toBeNull();
  });
});
