import { describe, expect, it } from 'vitest';

import {
  createAcpStartupDiagnostics,
  createAcpStartupError,
  formatStartupDiagnostics,
  isAcpStartupError,
  type AcpStartupDiagnostics,
} from '../src/diagnostics.js';
import type { AgentProfile } from '../src/agents.js';

const agent: AgentProfile = {
  id: 'test-agent',
  displayName: 'Test Agent',
  command: 'test-agent-cli',
  args: ['--acp'],
};

describe('diagnostics hint generation', () => {
  it('generates command-not-found hint for ENOENT', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      error: new Error('spawn test-agent-cli ENOENT'),
    });
    expect(diag.hints.find((h) => h.code === 'command-not-found')).toBeDefined();
    expect(diag.hints[0].message).toContain('test-agent-cli');
  });

  it('generates command-not-found hint for "not recognized"', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      error: new Error('command not found'),
    });
    expect(diag.hints.find((h) => h.code === 'command-not-found')).toBeDefined();
  });

  it('generates command-not-found hint for "cannot find"', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      error: new Error('cannot find the specified program'),
    });
    expect(diag.hints.find((h) => h.code === 'command-not-found')).toBeDefined();
  });

  it('generates startup-timeout hint', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP initialize',
      error: new Error('ACP initialize timed out after 30000ms'),
    });
    expect(diag.hints.find((h) => h.code === 'startup-timeout')).toBeDefined();
  });

  it('generates GitHub Copilot ACP initialize guidance', () => {
    const diag = createAcpStartupDiagnostics({
      agent: {
        id: 'github-copilot',
        displayName: 'GitHub Copilot',
        command: 'copilot-language-server',
        args: ['--acp'],
        fallbackCommands: [{ command: 'npx', args: ['--yes', '@github/copilot-language-server@latest', '--acp'] }],
        startupTimeoutMs: 90000,
      },
      label: 'ACP initialize',
      phase: 'initialize',
      error: new Error('ACP initialize failed for agent github-copilot during initialize'),
    });

    const hint = diag.hints.find((h) => h.code === 'github-copilot-acp');
    expect(hint).toBeDefined();
    expect(hint?.command).toBe('npx --yes @github/copilot-language-server@latest --acp');
  });

  it('generates auth-required hint for "login" messages', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP session/new',
      error: new Error('please login first'),
    });
    expect(diag.hints.find((h) => h.code === 'auth-required')).toBeDefined();
  });

  it('generates auth-required hint for "sign in" in stderr', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP session/new',
      error: new Error('session failed'),
      transportDiagnostics: { stderr: 'Please sign in to continue' },
    });
    expect(diag.hints.find((h) => h.code === 'auth-required')).toBeDefined();
  });

  it('generates package-manager-or-network hint for npm errors', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      error: new Error('npx failed to download'),
    });
    expect(diag.hints.find((h) => h.code === 'package-manager-or-network')).toBeDefined();
  });

  it('generates package-manager-or-network hint for certificate errors', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      error: new Error('unable to verify the first certificate'),
    });
    expect(diag.hints.find((h) => h.code === 'package-manager-or-network')).toBeDefined();
  });

  it('generates package-manager-or-network hint for proxy errors', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      error: new Error('proxy authentication required'),
    });
    const networkHint = diag.hints.find((h) => h.code === 'package-manager-or-network');
    expect(networkHint).toBeDefined();
  });

  it('generates package-manager-or-network hint for ECONNRESET', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      error: new Error('request failed with ECONNRESET'),
    });
    expect(diag.hints.find((h) => h.code === 'package-manager-or-network')).toBeDefined();
  });

  it('generates package-manager-or-network hint for ETIMEDOUT', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      error: new Error('request failed with ETIMEDOUT'),
    });
    expect(diag.hints.find((h) => h.code === 'package-manager-or-network')).toBeDefined();
  });

  it('generates process-exited hint when exitSummary is present and no other hints match', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP initialize',
      error: new Error('connection lost'),
      transportDiagnostics: { exitSummary: 'exit code=1', exitCode: 1 },
    });
    expect(diag.hints.find((h) => h.code === 'process-exited')).toBeDefined();
  });

  it('reports npx fallback launch metadata and hint when ACP used a fallback wrapper', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      error: new Error('connect failed'),
      transportDiagnostics: {
        launchSource: 'fallback',
        resolvedCommand: 'C:\\Users\\me\\AppData\\Roaming\\npm\\npx.cmd',
        resolvedArgs: ['--yes', '@zed-industries/codex-acp@latest'],
        lookupDurationMs: 14,
        usedNpxFallback: true,
        firstStdoutMs: 420,
      },
    });

    expect(diag.launchSource).toBe('fallback');
    expect(diag.usedNpxFallback).toBe(true);
    expect(diag.hints.find((hint) => hint.code === 'npx-fallback')).toBeDefined();
    expect(formatStartupDiagnostics(diag)).toContain('Launch source: fallback (via npx)');
    expect(formatStartupDiagnostics(diag)).toContain('First stdout: 420ms');
  });

  it('does not generate process-exited hint when other hints already match', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      error: new Error('spawn test-agent-cli ENOENT'),
      transportDiagnostics: { exitSummary: 'exit code=127' },
    });
    expect(diag.hints.find((h) => h.code === 'process-exited')).toBeUndefined();
    expect(diag.hints.find((h) => h.code === 'command-not-found')).toBeDefined();
  });

  it('can generate multiple hints at once', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      error: new Error('auth required, please login'),
      transportDiagnostics: { stderr: 'npx: command timed out' },
    });
    const codes = diag.hints.map((h) => h.code);
    expect(codes).toContain('auth-required');
    expect(codes).toContain('package-manager-or-network');
    expect(codes).toContain('startup-timeout');
  });

  it('generates no hints for generic errors without diagnostics', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP initialize',
      error: new Error('unexpected internal failure'),
    });
    expect(diag.hints).toEqual([]);
  });
});

describe('diagnostics phase inference', () => {
  it('infers authenticate phase', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP authenticate',
      error: new Error('failed'),
    });
    expect(diag.phase).toBe('authenticate');
  });

  it('infers session-load phase', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP session/load',
      error: new Error('not found'),
    });
    expect(diag.phase).toBe('session-load');
  });

  it('infers session-new phase', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP session/new',
      error: new Error('rejected'),
    });
    expect(diag.phase).toBe('session-new');
  });

  it('infers connect phase', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      error: new Error('refused'),
    });
    expect(diag.phase).toBe('connect');
  });

  it('infers unknown phase for unrecognized labels', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'something else',
      error: new Error('oops'),
    });
    expect(diag.phase).toBe('unknown');
  });

  it('respects explicit phase override', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP connect',
      phase: 'authenticate',
      error: new Error('failed'),
    });
    expect(diag.phase).toBe('authenticate');
  });
});

describe('diagnostics metadata', () => {
  it('captures platform and node version', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP initialize',
      error: new Error('fail'),
    });
    expect(diag.platform).toBe(process.platform);
    expect(diag.nodeVersion).toBe(process.version);
  });

  it('computes durationMs from startedAt', () => {
    const before = Date.now();
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP initialize',
      error: new Error('fail'),
      startedAt: before - 500,
    });
    expect(diag.durationMs).toBeGreaterThanOrEqual(500);
  });

  it('captures stderr and stdout tails', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP initialize',
      error: new Error('fail'),
      transportDiagnostics: {
        stderr: 'error output',
        stdout: 'normal output',
      },
    });
    expect(diag.stderrTail).toBe('error output');
    expect(diag.stdoutTail).toBe('normal output');
  });

  it('trims long stderr/stdout to 32KB', () => {
    const longString = 'x'.repeat(40_000);
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP initialize',
      error: new Error('fail'),
      transportDiagnostics: { stderr: longString },
    });
    expect(diag.stderrTail!.length).toBe(32_768);
  });

  it('handles undefined stderr/stdout', () => {
    const diag = createAcpStartupDiagnostics({
      agent,
      label: 'ACP initialize',
      error: new Error('fail'),
      transportDiagnostics: {},
    });
    expect(diag.stderrTail).toBeUndefined();
    expect(diag.stdoutTail).toBeUndefined();
  });

  it('copies agent args without mutating original', () => {
    const originalArgs = ['--acp'];
    const diag = createAcpStartupDiagnostics({
      agent: { ...agent, args: originalArgs },
      label: 'ACP initialize',
      error: new Error('fail'),
    });
    diag.args.push('--extra');
    expect(originalArgs).toEqual(['--acp']);
  });
});

describe('createAcpStartupError', () => {
  it('returns the same error if already an AcpStartupError', () => {
    const original = createAcpStartupError({
      agent,
      label: 'ACP initialize',
      error: new Error('original'),
    });
    const result = createAcpStartupError({
      agent,
      label: 'ACP initialize',
      error: original,
    });
    expect(result).toBe(original);
  });

  it('creates an AcpStartupError with formatted message', () => {
    const error = createAcpStartupError({
      agent,
      label: 'ACP initialize',
      error: new Error('something broke'),
    });
    expect(error.name).toBe('AcpStartupError');
    expect(error.message).toContain('test-agent');
    expect(error.message).toContain('something broke');
    expect(error.diagnostics.agentId).toBe('test-agent');
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe('formatStartupDiagnostics', () => {
  it('includes all sections in formatted output', () => {
    const diag: AcpStartupDiagnostics = {
      agentId: 'test-agent',
      agentDisplayName: 'Test Agent',
      command: 'test-agent-cli',
      args: ['--acp'],
      cwd: '/repo',
      label: 'ACP initialize',
      phase: 'initialize',
      platform: process.platform,
      nodeVersion: process.version,
      path: process.env.PATH,
      durationMs: 5000,
      process: { exitSummary: 'exit code=1', exitCode: 1, signal: null },
      stderrTail: 'login required',
      originalMessage: 'something broke',
      hints: [{ code: 'auth-required', message: 'Complete CLI login.' }],
    };

    const formatted = formatStartupDiagnostics(diag);
    expect(formatted).toContain('test-agent');
    expect(formatted).toContain('initialize');
    expect(formatted).toContain('test-agent-cli --acp');
    expect(formatted).toContain('/repo');
    expect(formatted).toContain('Platform:');
    expect(formatted).toContain('Node:');
    expect(formatted).toContain('PATH:');
    expect(formatted).toContain('5000ms');
    expect(formatted).toContain('exit code=1');
    expect(formatted).toContain('something broke');
    expect(formatted).toContain('login required');
    expect(formatted).toContain('Suggested fixes');
    expect(formatted).toContain('Complete CLI login.');
  });

  it('omits optional sections when not present', () => {
    const diag: AcpStartupDiagnostics = {
      agentId: 'test',
      command: 'test',
      args: [],
      label: 'ACP connect',
      phase: 'connect',
      originalMessage: 'err',
      hints: [],
    };
    const formatted = formatStartupDiagnostics(diag);
    expect(formatted).not.toContain('CWD:');
    expect(formatted).not.toContain('Duration:');
    expect(formatted).not.toContain('Process:');
    expect(formatted).not.toContain('stderr:');
    expect(formatted).not.toContain('Suggested fixes');
  });
});

describe('isAcpStartupError', () => {
  it('returns true for actual AcpStartupError instances', () => {
    const error = createAcpStartupError({ agent, label: 'x', error: new Error('y') });
    expect(isAcpStartupError(error)).toBe(true);
  });

  it('returns true for duck-typed objects with correct name and diagnostics', () => {
    const fake = { name: 'AcpStartupError', diagnostics: { agentId: 'test' } };
    expect(isAcpStartupError(fake)).toBe(true);
  });

  it('returns false for regular errors', () => {
    expect(isAcpStartupError(new Error('nope'))).toBe(false);
    expect(isAcpStartupError(null)).toBe(false);
    expect(isAcpStartupError(undefined)).toBe(false);
    expect(isAcpStartupError('string')).toBe(false);
  });
});
