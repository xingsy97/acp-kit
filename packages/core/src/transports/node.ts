import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
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
  AcpStartupObserver,
  AcpTransportSession,
} from '../runtime.js';
import { composeWireMiddleware, normalizeWireMiddleware } from '../wire-middleware.js';
import { isCommandOnPath, resolveCommandOnPath } from '../command-exists.js';

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
    async connect({ agent, host, client, cwd, startupObserver }) {
      const launch = await resolveAgentLaunch(agent, host, cwd ?? process.cwd(), startupObserver);
      const launchAgent = { ...agent, command: launch.command, args: launch.args };
      const spawnStartedAt = Date.now();
      startupObserver?.mark({
        phase: 'adapter process spawn begin',
        at: spawnStartedAt,
        detail: {
          launchSource: launch.source,
          requestedCommand: agent.command,
          resolvedCommand: launch.command,
          lookupDurationMs: launch.lookupDurationMs,
          usedNpxFallback: launch.usedNpxFallback,
          usedPackageCache: launch.usedPackageCache,
          fallbackPackage: launch.fallbackPackage,
        },
      });
      const child = spawnProcess(launchAgent.command, launchAgent.args, {
        cwd: cwd ?? process.cwd(),
        env: {
          ...process.env,
          ...agent.env,
        },
      });
      startupObserver?.mark({
        phase: 'adapter process spawn end',
        at: Date.now(),
        detail: {
          spawnDurationMs: Date.now() - spawnStartedAt,
          resolvedCommand: launch.command,
        },
      });
      const monitor = monitorProcess(child, host, startupObserver, spawnStartedAt);
      const baseConnection = connectionFactory.create({
        client,
        process: child,
        agent: launchAgent,
        host,
      }) as AcpTransportConnection;

      // NB: do NOT spread `baseConnection` — it is a class instance
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
            stdout: monitor.getStdout(),
            exitSummary: monitor.getExitSummary(),
            exitCode: monitor.getExitCode(),
            signal: monitor.getSignal(),
            launchSource: launch.source,
            resolvedCommand: launch.command,
            resolvedArgs: [...launch.args],
            lookupDurationMs: launch.lookupDurationMs,
            usedNpxFallback: launch.usedNpxFallback,
            usedPackageCache: launch.usedPackageCache,
            fallbackPackage: launch.fallbackPackage,
            firstStdoutMs: monitor.getFirstStdoutMs(),
            firstStderrMs: monitor.getFirstStderrMs(),
          };
        },
      };
      return session;
    },
  };
}

interface AgentLaunch {
  command: string;
  args: string[];
  source: 'primary' | 'fallback' | 'unresolved';
  lookupDurationMs: number;
  usedNpxFallback: boolean;
  usedPackageCache?: boolean;
  fallbackPackage?: string;
}

async function resolveAgentLaunch(
  agent: AgentProfile,
  host: RuntimeHost,
  cwd: string,
  startupObserver?: AcpStartupObserver,
): Promise<AgentLaunch> {
  const lookupStartedAt = Date.now();
  const primaryCommand = resolveCommandOnPath(agent.command);
  if (primaryCommand) {
    return {
      command: primaryCommand,
      args: [...agent.args],
      source: 'primary',
      lookupDurationMs: Date.now() - lookupStartedAt,
      usedNpxFallback: false,
    };
  }

  for (const fallback of agent.fallbackCommands ?? []) {
    const packageLaunch = await resolvePackageFallbackLaunch({
      agent,
      fallback,
      cwd,
      host,
      startupObserver,
      lookupStartedAt,
    });
    if (packageLaunch) {
      logFallbackLaunch(host, agent, fallback);
      return packageLaunch;
    }

    const fallbackCommand = resolveCommandOnPath(fallback.command);
    if (fallbackCommand) {
      logFallbackLaunch(host, agent, fallback);
      return {
        command: fallbackCommand,
        args: [...fallback.args],
        source: 'fallback',
        lookupDurationMs: Date.now() - lookupStartedAt,
        usedNpxFallback: fallback.command.toLowerCase() === 'npx' || /[\\/]npx(\.cmd)?$/i.test(fallbackCommand),
      };
    }
  }
  return {
    command: agent.command,
    args: [...agent.args],
    source: 'unresolved',
    lookupDurationMs: Date.now() - lookupStartedAt,
    usedNpxFallback: false,
  };
}

function logFallbackLaunch(
  host: RuntimeHost,
  agent: AgentProfile,
  fallback: NonNullable<AgentProfile['fallbackCommands']>[number],
): void {
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
}

async function resolvePackageFallbackLaunch(params: {
  agent: AgentProfile;
  fallback: NonNullable<AgentProfile['fallbackCommands']>[number];
  cwd: string;
  host: RuntimeHost;
  startupObserver?: AcpStartupObserver;
  lookupStartedAt: number;
}): Promise<AgentLaunch | null> {
  const parsed = parseNpxPackageFallback(params.agent, params.fallback);
  if (!parsed) return null;

  const localBin = resolvePackageBinFromProject(params.cwd, parsed.binName);
  if (localBin) {
    return packageLaunch(localBin, parsed.extraArgs, params.lookupStartedAt, false, parsed.packageSpec);
  }

  const runtimeBin = resolvePackageBinFromRuntime(parsed.binName);
  if (runtimeBin) {
    return packageLaunch(runtimeBin, parsed.extraArgs, params.lookupStartedAt, false, parsed.packageSpec);
  }

  const cacheDir = packageCacheDir(parsed.packageSpec);
  const cachedBin = resolvePackageBinFromPrefix(cacheDir, parsed.binName);
  if (cachedBin) {
    return packageLaunch(cachedBin, parsed.extraArgs, params.lookupStartedAt, true, parsed.packageSpec);
  }

  const rawFallbackCommand = resolveCommandOnPath(params.fallback.command);
  if (rawFallbackCommand) {
    return {
      command: rawFallbackCommand,
      args: [...params.fallback.args],
      source: 'fallback',
      lookupDurationMs: Date.now() - params.lookupStartedAt,
      usedNpxFallback: true,
      fallbackPackage: parsed.packageSpec,
    };
  }

  const globalBin = await resolvePackageBinFromNpmGlobalPrefix(parsed.binName);
  if (globalBin) {
    return packageLaunch(globalBin, parsed.extraArgs, params.lookupStartedAt, false, parsed.packageSpec);
  }

  const preparedBin = await prepareCachedPackageBin({
    packageSpec: parsed.packageSpec,
    binName: parsed.binName,
    cacheDir,
    host: params.host,
    startupObserver: params.startupObserver,
  });
  if (preparedBin) {
    return packageLaunch(preparedBin, parsed.extraArgs, params.lookupStartedAt, true, parsed.packageSpec);
  }

  return null;
}

function parseNpxPackageFallback(
  agent: AgentProfile,
  fallback: NonNullable<AgentProfile['fallbackCommands']>[number],
): { packageSpec: string; binName: string; extraArgs: string[] } | null {
  if (fallback.command.toLowerCase() !== 'npx') return null;
  const packageIndex = fallback.args.findIndex((arg) => arg && !arg.startsWith('-'));
  if (packageIndex < 0) return null;
  const packageSpec = fallback.args[packageIndex];
  if (!packageSpec) return null;
  return {
    packageSpec,
    binName: agent.command,
    extraArgs: fallback.args.slice(packageIndex + 1),
  };
}

function packageLaunch(
  command: string,
  args: string[],
  lookupStartedAt: number,
  usedPackageCache: boolean,
  fallbackPackage: string,
): AgentLaunch {
  return {
    command,
    args,
    source: 'fallback',
    lookupDurationMs: Date.now() - lookupStartedAt,
    usedNpxFallback: false,
    usedPackageCache,
    fallbackPackage,
  };
}

function resolvePackageBinFromProject(cwd: string, binName: string): string | null {
  let current = resolve(cwd);
  while (true) {
    const found = resolvePackageBinFromPrefix(current, binName);
    if (found) return found;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolvePackageBinFromRuntime(binName: string): string | null {
  let current = resolve(import.meta.dirname ?? process.cwd());
  while (true) {
    const found = resolvePackageBinFromPrefix(current, binName);
    if (found) return found;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function resolvePackageBinFromNpmGlobalPrefix(binName: string): Promise<string | null> {
  const npmCommand = resolveCommandOnPath('npm');
  if (!npmCommand) return null;
  const launch = resolveLaunch(npmCommand, ['prefix', '-g']);
  const result = await runProcess(launch.command, launch.args, { timeoutMs: 1500 });
  if (result.status !== 0) return null;
  const prefix = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (!prefix) return null;
  const binDir = process.platform === 'win32' ? prefix : join(prefix, 'bin');
  return resolveExecutableCandidate(join(binDir, binName));
}

function packageCacheRoot(): string {
  return process.env.ACP_KIT_AGENT_CACHE_DIR
    || join(homedir(), '.acp-kit', 'agent-bin-cache');
}

function packageCacheDir(packageSpec: string): string {
  const safeName = packageSpec.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'package';
  return join(packageCacheRoot(), safeName);
}

async function prepareCachedPackageBin(params: {
  packageSpec: string;
  binName: string;
  cacheDir: string;
  host: RuntimeHost;
  startupObserver?: AcpStartupObserver;
}): Promise<string | null> {
  const npmCommand = resolveCommandOnPath('npm');
  if (!npmCommand) return null;

  const startedAt = Date.now();
  params.startupObserver?.mark({
    phase: 'fallback package prepare begin',
    at: startedAt,
    detail: {
      package: params.packageSpec,
      cacheDir: params.cacheDir,
    },
  });

  try {
    mkdirSync(params.cacheDir, { recursive: true });
  } catch (error) {
    params.host.log?.({
      level: 'warn',
      message: 'Failed to create ACP fallback package cache directory.',
      context: { error: error instanceof Error ? error.message : String(error), cacheDir: params.cacheDir },
    });
    return null;
  }

  const launch = resolveLaunch(npmCommand, [
    'install',
    '--prefix',
    params.cacheDir,
    '--no-audit',
    '--no-fund',
    params.packageSpec,
  ]);
  const result = await runProcess(launch.command, launch.args, {
    timeoutMs: Number(process.env.ACP_KIT_AGENT_CACHE_INSTALL_TIMEOUT_MS || 120000),
  });

  params.startupObserver?.mark({
    phase: 'fallback package prepare end',
    at: Date.now(),
    detail: {
      package: params.packageSpec,
      cacheDir: params.cacheDir,
      durationMs: Date.now() - startedAt,
      status: result.status,
      timedOut: Boolean(result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'),
    },
  });

  if (result.status !== 0) {
    params.host.log?.({
      level: 'warn',
      message: 'Failed to prepare cached ACP fallback package; falling back to npx.',
      context: {
        package: params.packageSpec,
        status: result.status,
        stderr: result.stderr?.toString().slice(-2000),
        error: result.error instanceof Error ? result.error.message : undefined,
      },
    });
    return null;
  }

  return resolvePackageBinFromPrefix(params.cacheDir, params.binName);
}

function runProcess(command: string, args: string[], options: { timeoutMs: number }): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`Process timed out after ${options.timeoutMs}ms.`) as NodeJS.ErrnoException;
      error.code = 'ETIMEDOUT';
      try { child.kill(); } catch { /* ignore */ }
      resolveResult({ status: null, stdout, stderr, error });
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ status: null, stdout, stderr, error });
    });
    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ status, stdout, stderr });
    });
  });
}

function resolvePackageBinFromPrefix(prefix: string, binName: string): string | null {
  return resolveExecutableCandidate(join(prefix, 'node_modules', '.bin', binName));
}

function resolveExecutableCandidate(basePath: string): string | null {
  if (process.platform !== 'win32') {
    return existsSync(basePath) ? basePath : null;
  }
  const parsed = parse(basePath);
  if (parsed.ext && existsSync(basePath)) return basePath;
  for (const ext of ['.cmd', '.ps1', '.exe', '.bat', '']) {
    const candidate = `${basePath}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
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

export function resolveLaunch(command: string, args: string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform !== 'win32') {
    return { command, args };
  }
  if (/\.ps1$/i.test(command)) {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
    };
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
  getStdout(): string;
  getExitSummary(): string | null;
  getExitCode(): number | null | undefined;
  getSignal(): NodeJS.Signals | null | undefined;
  getFirstStdoutMs(): number | null;
  getFirstStderrMs(): number | null;
}

function monitorProcess(
  child: SpawnedProcess,
  host: RuntimeHost,
  startupObserver?: AcpStartupObserver,
  startedAt = Date.now(),
): ProcessMonitor {
  let stderrBuffer = '';
  let stdoutBuffer = '';
  let exitSummary: string | null = null;
  let exitCode: number | null | undefined;
  let exitSignal: NodeJS.Signals | null | undefined;
  let firstStdoutMs: number | null = null;
  let firstStderrMs: number | null = null;

  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString();
    stdoutBuffer += text;
    if (stdoutBuffer.length > 32_768) {
      stdoutBuffer = stdoutBuffer.slice(-32_768);
    }
    if (firstStdoutMs === null) {
      firstStdoutMs = Date.now() - startedAt;
      startupObserver?.once?.({
        phase: 'first adapter stdout',
        at: Date.now(),
        detail: { firstStdoutMs },
      });
    }
  });

  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    if (stderrBuffer.length > 32_768) {
      stderrBuffer = stderrBuffer.slice(-32_768);
    }
    if (firstStderrMs === null) {
      firstStderrMs = Date.now() - startedAt;
      startupObserver?.once?.({
        phase: 'first adapter stderr',
        at: Date.now(),
        detail: { firstStderrMs },
      });
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
    getStdout() {
      return stdoutBuffer.trim();
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
    getFirstStdoutMs() {
      return firstStdoutMs;
    },
    getFirstStderrMs() {
      return firstStderrMs;
    },
  };
}
