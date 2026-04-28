import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveCommandOnPath } from '../src/command-exists.js';

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
});
