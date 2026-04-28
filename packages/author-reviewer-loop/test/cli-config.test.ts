import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRunConfig } from '../lib/cli/config.mjs';
import { formatRunSummary } from '../lib/cli/summary.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.chdir(ORIGINAL_CWD);
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'author-reviewer-loop-'));
}

describe('author-reviewer-loop CLI config', () => {
  it('uses the TUI renderer by default and --cli opts into the plain renderer', () => {
    const cwd = tempDir();

    expect(parseRunConfig({ argv: [cwd, 'Build the thing', '--yes'] }).tui).toBe(true);
    expect(parseRunConfig({ argv: [cwd, 'Build the thing', '--yes', '--cli'] }).tui).toBe(false);

    process.env.ACP_REVIEW_CLI = '1';
    expect(parseRunConfig({ argv: [cwd, 'Build the thing', '--yes'] }).tui).toBe(false);
  });

  it('gives explicit renderer flags precedence over compatibility environment flags', () => {
    const cwd = tempDir();

    process.env.ACP_REVIEW_TUI = '1';
    expect(parseRunConfig({ argv: [cwd, 'Build the thing', '--yes', '--cli'] }).tui).toBe(false);

    process.env.ACP_REVIEW_CLI = '1';
    delete process.env.ACP_REVIEW_TUI;
    expect(parseRunConfig({ argv: [cwd, 'Build the thing', '--yes', '--tui'] }).tui).toBe(true);
  });

  it('reports invalid startup config through the CLI formatter', () => {
    const cwd = tempDir();
    const bin = path.resolve('packages', 'author-reviewer-loop', 'bin', 'acp-author-reviewer-loop.mjs');
    const result = spawnSync(process.execPath, [bin, cwd, 'Build the thing', '--yes', '--cli'], {
      cwd: ORIGINAL_CWD,
      encoding: 'utf8',
      env: {
        ...process.env,
        AUTHOR_AGENT: 'missing-agent',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AUTHOR_AGENT=missing-agent is not supported');
    expect(result.stderr).not.toContain('at envChoice');
  });

  it('resolves relative and absolute task files once at startup', () => {
    const cwd = tempDir();
    const taskFile = path.join(cwd, 'task with spaces.txt');
    fs.writeFileSync(taskFile, 'file task\nwith details', 'utf8');

    process.chdir(cwd);
    const relative = parseRunConfig({ argv: [cwd, 'task with spaces.txt', '--yes', '--cli'] });
    const absolute = parseRunConfig({ argv: [cwd, taskFile, '--yes', '--cli'] });

    fs.writeFileSync(taskFile, 'changed later', 'utf8');

    expect(relative.task).toBe('file task\nwith details');
    expect(relative.taskSource).toEqual({ kind: 'file', path: taskFile });
    expect(absolute.task).toBe('file task\nwith details');
    expect(absolute.taskSource).toEqual({ kind: 'file', path: taskFile });
  });

  it('keeps inline text when the task value is not a readable file', () => {
    const cwd = tempDir();
    const config = parseRunConfig({ argv: [cwd, 'Create docs for missing-file.txt', '--yes', '--cli'] });

    expect(config.task).toBe('Create docs for missing-file.txt');
    expect(config.taskSource).toEqual({ kind: 'text' });
  });

  it('formats the full task in the confirmation summary', () => {
    const task = ['first line', 'second line', 'third line'].join('\n');
    const config = parseRunConfig({ argv: [tempDir(), task, '--yes', '--cli'] });

    expect(formatRunSummary(config)).toContain(`task:           ${task}`);
  });

  it('uses edited task text in future prompts', () => {
    const config = parseRunConfig({ argv: [tempDir(), 'original task', '--yes', '--cli'] });

    config.task = 'edited task';

    expect(config.authorSettings.prompt({ round: 1, feedback: '' })).toContain('Task: edited task');
    expect(config.authorSettings.prompt({ round: 2, feedback: 'fix it' })).toContain('Current task: edited task');
    expect(config.reviewerSettings.prompt({ round: 1, feedback: '' })).toContain('Original task: edited task');
  });

  it('includes round and previous feedback in reviewer prompts', () => {
    const config = parseRunConfig({ argv: [tempDir(), 'build it', '--yes', '--cli'] });
    const prompt = config.reviewerSettings.prompt({ round: 2, feedback: '1. Missing tests' });

    expect(prompt).toContain('Round: 2');
    expect(prompt).toContain('Previous reviewer feedback:\n1. Missing tests');
  });
});
