import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createStartupProfileFileLogger,
  createStartupProfiler,
  startupProfileFilePath,
  startupProfilingEnabled,
} from '../lib/runtime/startup-profile.mjs';

const TEMP_DIRS: string[] = [];

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spar-startup-profile-'));
  TEMP_DIRS.push(dir);
  return dir;
}

describe('startup profiling', () => {
  it('is enabled by default and can be explicitly disabled', () => {
    expect(startupProfilingEnabled({})).toBe(true);
    expect(startupProfilingEnabled({ ACP_STARTUP_PROFILE: '1' })).toBe(true);
    expect(startupProfilingEnabled({ ACP_STARTUP_PROFILE: 'true' })).toBe(true);
    expect(startupProfilingEnabled({ ACP_STARTUP_PROFILE: '0' })).toBe(false);
    expect(startupProfilingEnabled({ ACP_STARTUP_PROFILE: 'off' })).toBe(false);
  });

  it('writes startup profile lines under the ACP Kit Spar directory', () => {
    const home = tempDir();
    const filePath = startupProfileFilePath({ home });
    const log = createStartupProfileFileLogger({ filePath });

    log('[ACP_STARTUP_PROFILE startup] +0ms Δ0ms begin');

    expect(filePath).toBe(path.join(home, '.acp-kit', 'spar', 'startup-profile.log'));
    expect(fs.readFileSync(filePath, 'utf8')).toContain('ACP_STARTUP_PROFILE startup');
  });

  it('uses the file logger when profiling startup marks', () => {
    const filePath = path.join(tempDir(), '.acp-kit', 'spar', 'startup-profile.log');
    const profiler = createStartupProfiler({
      scope: 'test-startup',
      log: createStartupProfileFileLogger({ filePath }),
    });

    profiler.mark({ phase: 'begin' });
    profiler.mark({ phase: 'ready', detail: { agent: 'codex' } });

    const log = fs.readFileSync(filePath, 'utf8');
    expect(log).toContain('[ACP_STARTUP_PROFILE test-startup]');
    expect(log).toContain('begin');
    expect(log).toContain('ready agent="codex"');
  });
});
