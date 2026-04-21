import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PassThrough, Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
} from '@agentclientprotocol/sdk';

import type { RuntimeHost } from '../host.js';
import type { AgentProfile } from '../profiles.js';
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
    profile: AgentProfile;
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
    async connect({ profile, host, client, cwd }) {
      const child = spawnProcess(profile.command, profile.args, {
        cwd: cwd ?? process.cwd(),
        env: {
          ...process.env,
          ...profile.env,
        },
      });
      const monitor = monitorProcess(child, host);
      const baseConnection = connectionFactory.create({
        client,
        process: child,
        profile,
        host,
      });

      const connection: AcpTransportConnection = {
        ...baseConnection,
        async dispose() {
          try {
            await baseConnection.dispose?.();
          } finally {
            try {
              child.kill();
            } catch {
              /* process may already be gone */
            }
          }
        },
      };

      const session: AcpTransportSession = {
        connection,
        getDiagnostics() {
          return {
            stderr: monitor.getStderr(),
            exitSummary: monitor.getExitSummary(),
          };
        },
      };
      return session;
    },
  };
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
    create({ client, process: child, profile, host }) {
      if (!child.stdin || !child.stdout) {
        throw new Error('The spawned ACP process did not expose stdin/stdout streams.');
      }
      const readable = profile.filterStdoutLine
        ? createFilteredReadable(child.stdout, profile.filterStdoutLine)
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
}

function monitorProcess(child: SpawnedProcess, host: RuntimeHost): ProcessMonitor {
  let stderrBuffer = '';
  let exitSummary: string | null = null;

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

  return {
    getStderr() {
      return stderrBuffer.trim();
    },
    getExitSummary() {
      return exitSummary;
    },
  };
}
