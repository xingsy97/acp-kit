import type { AgentProfile } from './agents.js';

export type AcpStartupFailurePhase =
  | 'connect'
  | 'initialize'
  | 'authenticate'
  | 'session-new'
  | 'session-load'
  | 'unknown';

export interface AcpTransportDiagnostics {
  stderr?: string;
  stdout?: string;
  exitSummary?: string | null;
  exitCode?: number | null;
  signal?: string | null;
}

export interface AcpStartupDiagnosticHint {
  code: string;
  message: string;
  command?: string;
}

export interface AcpStartupDiagnostics {
  agentId: string;
  agentDisplayName?: string;
  command: string;
  args: string[];
  cwd?: string;
  label: string;
  phase: AcpStartupFailurePhase;
  platform?: string;
  nodeVersion?: string;
  durationMs?: number;
  process?: {
    exitSummary?: string | null;
    exitCode?: number | null;
    signal?: string | null;
  };
  stderrTail?: string;
  stdoutTail?: string;
  originalMessage: string;
  hints: AcpStartupDiagnosticHint[];
}

export class AcpStartupError extends Error {
  readonly diagnostics: AcpStartupDiagnostics;
  readonly cause: unknown;

  constructor(message: string, diagnostics: AcpStartupDiagnostics, cause: unknown) {
    super(message);
    this.name = 'AcpStartupError';
    this.diagnostics = diagnostics;
    this.cause = cause;
  }
}

export function isAcpStartupError(error: unknown): error is AcpStartupError {
  return error instanceof AcpStartupError
    || Boolean(error && typeof error === 'object' && 'diagnostics' in error && (error as { name?: string }).name === 'AcpStartupError');
}

export function createAcpStartupDiagnostics(params: {
  agent: AgentProfile;
  label: string;
  phase?: AcpStartupFailurePhase;
  cwd?: string;
  startedAt?: number;
  error: unknown;
  transportDiagnostics?: AcpTransportDiagnostics;
}): AcpStartupDiagnostics {
  const originalMessage = params.error instanceof Error ? params.error.message : String(params.error);
  const diagnostics = params.transportDiagnostics || {};
  const stderrTail = trimTail(diagnostics.stderr, 32_768);
  const stdoutTail = trimTail(diagnostics.stdout, 32_768);

  return {
    agentId: params.agent.id,
    agentDisplayName: params.agent.displayName,
    command: params.agent.command,
    args: [...params.agent.args],
    cwd: params.cwd,
    label: params.label,
    phase: params.phase ?? inferFailurePhase(params.label, originalMessage),
    platform: typeof process !== 'undefined' ? process.platform : undefined,
    nodeVersion: typeof process !== 'undefined' ? process.version : undefined,
    durationMs: params.startedAt ? Date.now() - params.startedAt : undefined,
    process: {
      exitSummary: diagnostics.exitSummary,
      exitCode: diagnostics.exitCode,
      signal: diagnostics.signal,
    },
    stderrTail,
    stdoutTail,
    originalMessage,
    hints: buildStartupHints({ agent: params.agent, originalMessage, stderrTail, diagnostics }),
  };
}

export function createAcpStartupError(params: {
  agent: AgentProfile;
  label: string;
  phase?: AcpStartupFailurePhase;
  cwd?: string;
  startedAt?: number;
  error: unknown;
  transportDiagnostics?: AcpTransportDiagnostics;
}): AcpStartupError {
  if (isAcpStartupError(params.error)) return params.error;
  const diagnostics = createAcpStartupDiagnostics(params);
  return new AcpStartupError(formatStartupDiagnostics(diagnostics), diagnostics, params.error);
}

export function formatStartupDiagnostics(diagnostics: AcpStartupDiagnostics): string {
  const lines = [
    `${diagnostics.label} failed for agent "${diagnostics.agentId}" during ${diagnostics.phase}.`,
    '',
    `Command: ${[diagnostics.command, ...diagnostics.args].join(' ')}`,
  ];
  if (diagnostics.cwd) lines.push(`CWD: ${diagnostics.cwd}`);
  if (diagnostics.durationMs !== undefined) lines.push(`Duration: ${diagnostics.durationMs}ms`);
  if (diagnostics.process?.exitSummary) lines.push(`Process: ${diagnostics.process.exitSummary}`);
  lines.push('', diagnostics.originalMessage);
  if (diagnostics.stderrTail) lines.push('', `stderr:\n${diagnostics.stderrTail}`);
  if (diagnostics.stdoutTail) lines.push('', `stdout:\n${diagnostics.stdoutTail}`);
  if (diagnostics.hints.length > 0) {
    lines.push('', 'Suggested fixes:');
    for (const hint of diagnostics.hints) {
      lines.push(`- ${hint.message}${hint.command ? ` (${hint.command})` : ''}`);
    }
  }
  return lines.join('\n');
}

function inferFailurePhase(label: string, message: string): AcpStartupFailurePhase {
  const value = `${label} ${message}`.toLowerCase();
  if (value.includes('authenticate')) return 'authenticate';
  if (value.includes('session/load')) return 'session-load';
  if (value.includes('session/new')) return 'session-new';
  if (value.includes('initialize')) return 'initialize';
  if (value.includes('connect')) return 'connect';
  return 'unknown';
}

function buildStartupHints(params: {
  agent: AgentProfile;
  originalMessage: string;
  stderrTail?: string;
  diagnostics: AcpTransportDiagnostics;
}): AcpStartupDiagnosticHint[] {
  const text = `${params.originalMessage}\n${params.stderrTail || ''}`.toLowerCase();
  const hints: AcpStartupDiagnosticHint[] = [];
  if (/enoent|not recognized|command not found|cannot find/.test(text)) {
    hints.push({
      code: 'command-not-found',
      message: `Verify that \`${params.agent.command}\` is installed and available on PATH.`,
      command: `${params.agent.command} --help`,
    });
  }
  if (/timed out|timeout/.test(text)) {
    hints.push({
      code: 'startup-timeout',
      message: 'Run the agent command manually, then increase agent.startupTimeoutMs if first launch installs packages or performs login.',
      command: [params.agent.command, ...params.agent.args].join(' '),
    });
  }
  if (/auth|login|sign in|signin/.test(text)) {
    hints.push({
      code: 'auth-required',
      message: 'Complete the agent CLI login flow before starting the ACP runtime.',
    });
  }
  if (/npm|npx|proxy|certificate|cert|econnreset|etimedout/.test(text)) {
    hints.push({
      code: 'package-manager-or-network',
      message: 'Check npm/npx network access, proxy settings, and registry authentication.',
      command: `npm view ${params.agent.args[0] || params.agent.command} version`,
    });
  }
  if (params.diagnostics.exitSummary && hints.length === 0) {
    hints.push({
      code: 'process-exited',
      message: 'Run the exact command manually to inspect the agent CLI failure outside ACP Kit.',
      command: [params.agent.command, ...params.agent.args].join(' '),
    });
  }
  return hints;
}

function trimTail(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(-maxLength);
}