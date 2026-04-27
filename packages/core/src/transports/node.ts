import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
} from '@agentclientprotocol/sdk';

import type { RuntimeHost } from '../host.js';
import type { AgentProfile } from '../agents.js';
import type {
  AcpTransport,
  AcpTransportConnection,
  AcpTransportSession,
} from '../runtime.js';
import { composeWireMiddleware, normalizeWireMiddleware } from '../wire-middleware.js';

/* ------------------------------------------------------------------------- */
/* Public process types                                                      */
/* ------------------------------------------------------------------------- */

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnedProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => SpawnedProcess;

/**
 * Legacy connection factory hook. Prefer custom `AcpTransport` instead.
 * Kept for backward compatibility.
 */
export interface AcpConnectionFactory {
  create(params: {
    client: Client;
    process: SpawnedProcess;
    agent: AgentProfile;
    /** Optional host — when provided, the SDK factory will tap wire frames into `host.onWireMessage`. */
    host?: RuntimeHost;
  }): AcpTransportConnection;
}

/* ------------------------------------------------------------------------- */
/* Default transport                                                         */
/* ------------------------------------------------------------------------- */

export interface NodeChildProcessTransportOptions {
  /** Override the process spawn function (defaults to `node:child_process` spawn with platform handling). */
  spawnProcess?: SpawnProcess;
  /** Override how the spawned process is wrapped into an ACP connection. */
  connectionFactory?: AcpConnectionFactory;
  /**
   * On macOS/Linux, launch the agent through the user's login shell so that
   * `PATH` includes nvm/Homebrew/etc. Useful when the host is a GUI app
   * (VS Code, Tauri shell) that didn't inherit the terminal `PATH`.
   * Default: `false`.
   */
  useLoginShell?: boolean;
}

/**
 * Default ACP transport: spawns the agent as a child process, wires stdin/stdout
 * with `ndJsonStream`, and bridges to a `ClientSideConnection`.
 */
export function nodeChildProcessTransport(
  options: NodeChildProcessTransportOptions = {},
): AcpTransport {
  const spawnProcess = options.spawnProcess
    || (options.useLoginShell
      ? createLoginShellSpawnProcess()
      : defaultSpawnProcess);
  const connectionFactory = options.connectionFactory || createSdkConnectionFactory();

  return {
    async connect({ agent, host, client, cwd }) {
      const launch = resolveAgentLaunch(agent, host);
      const launchAgent = launch === agent
        ? agent
        : { ...agent, command: launch.command, args: launch.args };
      const child = spawnProcess(launchAgent.command, launchAgent.args, {
        cwd: cwd ?? process.cwd(),
        env: {
          ...process.env,
          ...agent.env,
        },
      });
      const monitor = monitorProcess(child, host);
      const baseConnection = connectionFactory.create({
        client,
        process: child,
        agent: launchAgent,
        host,
      }) as AcpTransportConnection;

      // NB: do NOT spread `baseConnection` &mdash; it is a class instance
      // (`ClientSideConnection`) whose methods live on the prototype, so a
      // spread silently strips `initialize` / `prompt` / etc. Wrap `dispose`
      // by assigning onto the instance instead.
      const originalDispose = (baseConnection as { dispose?: () => Promise<void> }).dispose
        ?.bind(baseConnection);
      (baseConnection as { dispose: () => Promise<void> }).dispose = async () => {
        try {
          await originalDispose?.();
        } finally {
          try {
            child.kill();
          } catch {
            /* process may already be gone */
          }
        }
      };
      const connection = baseConnection;

      const session: AcpTransportSession = {
        connection,
        getDiagnostics() {
          return {
            stderr: monitor.getStderr(),
            exitSummary: monitor.getExitSummary(),
            exitCode: monitor.getExitCode(),
            signal: monitor.getSignal(),
          };
        },
      };
      return session;
    },
  };
}

function resolveAgentLaunch(agent: AgentProfile, host: RuntimeHost): { command: string; args: string[] } | AgentProfile {
  if (isCommandOnPath(agent.command)) return agent;
  for (const fallback of agent.fallbackCommands ?? []) {
    if (isCommandOnPath(fallback.command)) {
      host.log?.({
        level: 'warn',
        message: 'ACP agent primary command was not found; using fallback command',
        context: {
          agentId: agent.id,
          missingCommand: agent.command,
          fallbackCommand: fallback.command,
          fallbackArgs: fallback.args,
        },
      });
      return fallback;
    }
  }
  return agent;
}

function isCommandOnPath(command: string): boolean {
  if (!command) return false;
  if (command.includes('/') || command.includes('\\') || isAbsolute(command)) {
    return existsSync(command);
  }

  const pathEnv = process.env.PATH || '';
  const paths = pathEnv.split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const base of paths) {
    const direct = join(base, command);
    if (existsSync(direct)) return true;
    for (const ext of extensions) {
      if (existsSync(direct + ext.toLowerCase()) || existsSync(direct + ext.toUpperCase())) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------------- */
/* Default spawn helpers                                                      */
/* ------------------------------------------------------------------------- */

export function defaultSpawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
): SpawnedProcess {
  const launch = resolveLaunch(command, args);
  return spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/**
 * macOS/Linux: launch the agent through the user's login shell so it inherits
 * `PATH` from `~/.zshrc`, `~/.bash_profile`, etc. On Windows behaves like
 * `defaultSpawnProcess` (which already routes `npx`/`*.cmd` through cmd.exe).
 */
export function createLoginShellSpawnProcess(): SpawnProcess {
  return (command, args, options) => {
    if (process.platform === 'win32') {
      return defaultSpawnProcess(command, args, options);
    }
    const { shell, useLoginFlag } = resolveUnixLoginShell();
    const commandLine = [command, ...args].map(shellEscape).join(' ');
    const shellArgs = useLoginFlag ? ['-l', '-c', commandLine] : ['-c', commandLine];
    return spawn(shell, shellArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function resolveUnixLoginShell(): { shell: string; useLoginFlag: boolean } {
  const userShell = process.env.SHELL;
  if (userShell) {
    const base = userShell.split('/').pop() || '';
    if (['zsh', 'bash', 'ksh'].includes(base)) {
      return { shell: userShell, useLoginFlag: true };
    }
    if (['fish', 'sh', 'dash'].includes(base)) {
      return { shell: userShell, useLoginFlag: false };
    }
  }
  if (existsSync('/bin/bash')) return { shell: '/bin/bash', useLoginFlag: true };
  if (existsSync('/usr/bin/bash')) return { shell: '/usr/bin/bash', useLoginFlag: true };
  return { shell: '/bin/sh', useLoginFlag: false };
}

function quoteWindowsArgument(value: string): string {
  if (!value) return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function resolveLaunch(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command, args };
  }
  const requiresCmd = command === 'npm' || command === 'npx' || /\.(cmd|bat)$/i.test(command);
  if (!requiresCmd) {
    return { command, args };
  }
  const commandLine = [quoteWindowsArgument(command), ...args.map(quoteWindowsArgument)].join(' ');
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
  };
}

/* ------------------------------------------------------------------------- */
/* SDK connection factory                                                     */
/* ------------------------------------------------------------------------- */

export function createSdkConnectionFactory(): AcpConnectionFactory {
  return {
    create({ client, process: child, agent, host }) {
      if (!child.stdin || !child.stdout) {
        throw new Error('The spawned ACP process did not expose stdin/stdout streams.');
      }
      const readable = agent.filterStdoutLine
        ? createFilteredReadable(child.stdout, agent.filterStdoutLine)
        : child.stdout;
      let stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(readable) as ReadableStream<Uint8Array>,
      );
      const middlewares = normalizeWireMiddleware(host?.wireMiddleware);
      if (middlewares.length > 0) {
        stream = applyWireMiddleware(stream, middlewares) as typeof stream;
      }
      return new ClientSideConnection(() => client, stream) as never as AcpTransportConnection;
    },
  };
}

/**
 * Wrap an `ndJsonStream` so that every frame in either direction is dispatched
 * through the host's wire middleware chain. Middlewares may observe, mutate,
 * or drop frames (by not calling `next()`).
 */
function applyWireMiddleware(
  stream: { writable: WritableStream<unknown>; readable: ReadableStream<unknown> },
  middlewares: import('../host.js').WireMiddleware[],
): { writable: WritableStream<unknown>; readable: ReadableStream<unknown> } {
  const outDispatch = composeWireMiddleware(middlewares, async (ctx) => {
    outWriter.enqueue(ctx.frame);
  });
  const inDispatch = composeWireMiddleware(middlewares, async (ctx) => {
    inWriter.enqueue(ctx.frame);
  });

  let outWriter!: TransformStreamDefaultController<unknown>;
  let inWriter!: TransformStreamDefaultController<unknown>;

  const sendTransform = new TransformStream<unknown, unknown>({
    start(controller) { outWriter = controller; },
    async transform(chunk) {
      try {
        await outDispatch({ direction: 'out', frame: chunk });
      } catch {
        outWriter.enqueue(chunk); // middleware threw — fail open, do not corrupt the wire
      }
    },
  });
  const recvTransform = new TransformStream<unknown, unknown>({
    start(controller) { inWriter = controller; },
    async transform(chunk) {
      try {
        await inDispatch({ direction: 'in', frame: chunk });
      } catch {
        inWriter.enqueue(chunk);
      }
    },
  });

  void sendTransform.readable.pipeTo(stream.writable).catch(() => { /* pipeline already closed */ });
  void stream.readable.pipeTo(recvTransform.writable).catch(() => { /* pipeline already closed */ });

  return { writable: sendTransform.writable, readable: recvTransform.readable };
}

function createFilteredReadable(source: Readable, filterLine: (line: string) => string | null): Readable {
  const output = new PassThrough();
  let buffer = '';

  source.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const filtered = filterLine(line);
      if (filtered !== null) {
        output.write(`${filtered}\n`);
      }
    }
  });
  source.on('end', () => {
    if (buffer) {
      const filtered = filterLine(buffer);
      if (filtered !== null) {
        output.write(filtered);
      }
    }
    output.end();
  });
  source.on('error', (error) => {
    output.destroy(error instanceof Error ? error : new Error(String(error)));
  });

  return output;
}

/* ------------------------------------------------------------------------- */
/* Process monitor (stderr buffer + exit notification)                        */
/* ------------------------------------------------------------------------- */

interface ProcessMonitor {
  getStderr(): string;
  getExitSummary(): string | null;
  getExitCode(): number | null | undefined;
  getSignal(): NodeJS.Signals | null | undefined;
}

function monitorProcess(child: SpawnedProcess, host: RuntimeHost): ProcessMonitor {
  let stderrBuffer = '';
  let exitSummary: string | null = null;
  let exitCode: number | null | undefined;
  let exitSignal: NodeJS.Signals | null | undefined;

  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    if (stderrBuffer.length > 32_768) {
      stderrBuffer = stderrBuffer.slice(-32_768);
    }
    host.log?.({
      level: 'debug',
      message: 'ACP child wrote to stderr',
      context: { text },
    });
  });

  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exitCode = code;
    exitSignal = signal;
    exitSummary = `exit code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}`;
    host.log?.({
      level: code === 0 ? 'info' : 'warn',
      message: 'ACP child exited',
      context: { code, signal },
    });
    host.onAgentExit?.({ code, signal, stderr: stderrBuffer.trim() });
  };

  const childWithEvents = child as SpawnedProcess & {
    on?: (event: string, listener: (...args: never[]) => void) => void;
  };
  childWithEvents.on?.('close', onExit as never);
  childWithEvents.on?.('error', ((error: NodeJS.ErrnoException) => {
    exitCode = undefined;
    exitSignal = undefined;
    exitSummary = `spawn error=${error.code ?? error.message}`;
    stderrBuffer += `${stderrBuffer ? '\n' : ''}${error.message}`;
    if (stderrBuffer.length > 32_768) {
      stderrBuffer = stderrBuffer.slice(-32_768);
    }
    host.log?.({
      level: 'error',
      message: 'ACP child process failed to spawn',
      context: { code: error.code, message: error.message, path: error.path, syscall: error.syscall },
    });
    host.onAgentExit?.({ code: null, signal: null, stderr: stderrBuffer.trim() });
  }) as never);

  return {
    getStderr() {
      return stderrBuffer.trim();
    },
    getExitSummary() {
      return exitSummary;
    },
    getExitCode() {
      return exitCode;
    },
    getSignal() {
      return exitSignal;
    },
  };
}
