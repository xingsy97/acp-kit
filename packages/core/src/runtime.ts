import { spawn } from 'node:child_process';
import { PassThrough, Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AuthMethod,
  type Client,
  type InitializeResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionModelState,
  type SessionModeState,
  type SessionNotification,
} from '@agentclientprotocol/sdk';

import type { RuntimeHost } from './host.js';
import { resolveAgentProfile, type AgentProfile, type BuiltInProfileId } from './profiles.js';
import { RuntimeSession, createInitialSessionEvents, type AcpConnectionLike } from './session.js';

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

export interface AcpConnectionFactory {
  create(params: {
    client: Client;
    process: SpawnedProcess;
    profile: AgentProfile;
  }): AcpConnectionLike & {
    initialize(params: Record<string, unknown>): Promise<InitializeResponse>;
    newSession(params: Record<string, unknown>): Promise<{
      sessionId: string;
      configOptions?: unknown[];
      modes?: unknown;
      models?: unknown;
    }>;
    authenticate?(params: { methodId: string }): Promise<unknown>;
  };
}

export interface RuntimeOptions {
  profile: AgentProfile | BuiltInProfileId;
  /**
   * Optional default working directory for sessions created via `newSession()` without an explicit `cwd`.
   * If omitted, callers MUST provide `cwd` to every `newSession({ cwd })` call.
   */
  cwd?: string;
  host: RuntimeHost;
  spawnProcess?: SpawnProcess;
  connectionFactory?: AcpConnectionFactory;
}

export interface NewSessionOptions {
  /**
   * The working directory for this session. Required unless the runtime was created with a default `cwd`.
   */
  cwd?: string;
  mcpServers?: unknown[];
}

interface ProcessMonitor {
  getStderr(): string;
  getExitSummary(): string | null;
}

export class AcpRuntime {
  private readonly profile: AgentProfile;
  private readonly cwd: string | undefined;
  private readonly host: RuntimeHost;
  private readonly spawnProcess: SpawnProcess;
  private readonly connectionFactory: AcpConnectionFactory;
  private readonly openSessions = new Set<RuntimeSession>();
  private shutdownStarted = false;

  constructor(options: RuntimeOptions) {
    this.profile = resolveAgentProfile(options.profile);
    this.cwd = options.cwd;
    this.host = options.host;
    this.spawnProcess = options.spawnProcess || defaultSpawnProcess;
    this.connectionFactory = options.connectionFactory || createSdkConnectionFactory();
  }

  async newSession(options: NewSessionOptions = {}): Promise<RuntimeSession> {
    if (this.shutdownStarted) {
      throw new Error('Cannot create a new session: runtime has been shut down.');
    }
    const cwd = options.cwd || this.cwd;
    if (!cwd) {
      throw new Error(
        'newSession requires a `cwd`. Either pass `{ cwd }` to newSession or provide a default `cwd` to createAcpRuntime.',
      );
    }
    const process = this.spawnProcess(this.profile.command, this.profile.args, {
      cwd,
      env: {
        ...processEnv(),
        ...this.profile.env,
      },
    });
    const monitor = monitorProcess(process, this.host);

    let updateHandler: ((notification: SessionNotification) => void) | null = null;
    let sessionIdForCallbacks = 'pending';

    const client = createClientBridge({
      host: this.host,
      getSessionId: () => sessionIdForCallbacks,
      onSessionUpdate: (notification) => updateHandler?.(notification),
    });

    const connection = this.connectionFactory.create({
      client,
      process,
      profile: this.profile,
    });

    const startupTimeoutMs = this.profile.startupTimeoutMs || 30000;
    const initResponse = await withStartupDiagnostics(
      withTimeout(
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: {
            name: '@acp-kit/core',
            version: '0.1.0',
          },
          clientCapabilities: {
            fs: {
              readTextFile: typeof this.host.readTextFile === 'function',
              writeTextFile: typeof this.host.writeTextFile === 'function',
            },
            terminal: Boolean(
              this.host.createTerminal
              && this.host.terminalOutput
              && this.host.waitForTerminalExit
              && this.host.killTerminal
              && this.host.releaseTerminal,
            ),
          },
        }),
        startupTimeoutMs,
        'ACP initialize',
      ),
      monitor,
      this.profile,
      'ACP initialize',
    );

    const sessionResponse = await this.createSessionWithAuthRetry({
      connection,
      initResponse,
      cwd,
      mcpServers: options.mcpServers || [],
      timeoutMs: startupTimeoutMs,
      monitor,
    });

    sessionIdForCallbacks = sessionResponse.sessionId;
    const initialEvents = createInitialSessionEvents({
      sessionId: sessionResponse.sessionId,
      configOptions: Array.isArray(sessionResponse.configOptions) ? sessionResponse.configOptions as never : undefined,
      modes: looksLikeModeState(sessionResponse.modes) ? sessionResponse.modes : undefined,
      models: looksLikeModelState(sessionResponse.models) ? sessionResponse.models : undefined,
    });

    const session = new RuntimeSession({
      sessionId: sessionResponse.sessionId,
      profile: this.profile,
      host: this.host,
      connection,
      initialEvents,
    });
    updateHandler = (notification) => {
      session.handleSessionUpdate(notification);
    };

    this.openSessions.add(session);
    const originalDispose = session.dispose.bind(session);
    session.dispose = async () => {
      try {
        await originalDispose();
      } finally {
        this.openSessions.delete(session);
      }
    };

    return session;
  }

  /**
   * Dispose every session created by this runtime. After shutdown, `newSession()` throws.
   * Idempotent.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    const errors: unknown[] = [];
    for (const session of [...this.openSessions]) {
      try {
        await session.dispose();
      } catch (err) {
        errors.push(err);
      }
    }
    this.openSessions.clear();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors as Error[], `${errors.length} sessions failed to dispose cleanly.`);
    }
  }

  /** ES Explicit Resource Management: enables `await using acp = createAcpRuntime(...)`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  private async createSessionWithAuthRetry(params: {
    connection: AcpConnectionFactory['create'] extends (...args: never[]) => infer T ? T : never;
    initResponse: InitializeResponse;
    cwd: string;
    mcpServers: unknown[];
    timeoutMs: number;
    monitor: ProcessMonitor;
  }) {
    try {
      return await withStartupDiagnostics(
        withTimeout(
          params.connection.newSession({
            cwd: params.cwd,
            mcpServers: params.mcpServers,
          }),
          params.timeoutMs,
          'ACP session/new',
        ),
        params.monitor,
        this.profile,
        'ACP session/new',
      );
    } catch (error) {
      if (!isAuthRequiredError(error)) {
        throw error;
      }

      const methodId = await chooseAuthMethod(this.host, params.initResponse.authMethods || []);
      if (!methodId) {
        throw new Error('Authentication was required but no auth method was selected.');
      }
      if (typeof params.connection.authenticate !== 'function') {
        throw new Error('Authentication is required, but the ACP connection does not support authenticate().');
      }

      await withStartupDiagnostics(
        withTimeout(
          params.connection.authenticate({ methodId }),
          params.timeoutMs,
          'ACP authenticate',
        ),
        params.monitor,
        this.profile,
        'ACP authenticate',
      );

      return withStartupDiagnostics(
        withTimeout(
          params.connection.newSession({
            cwd: params.cwd,
            mcpServers: params.mcpServers,
          }),
          params.timeoutMs,
          'ACP session/new (after auth)',
        ),
        params.monitor,
        this.profile,
        'ACP session/new (after auth)',
      );
    }
  }
}

export function createRuntime(options: RuntimeOptions): AcpRuntime {
  return new AcpRuntime(options);
}

/**
 * Preferred constructor for the ACP Kit runtime.
 * Equivalent to `createRuntime` (which is kept as an alias for callers that imported the older name).
 */
export function createAcpRuntime(options: RuntimeOptions): AcpRuntime {
  return new AcpRuntime(options);
}

export function createSdkConnectionFactory(): AcpConnectionFactory {
  return {
    create({ client, process, profile }) {
      if (!process.stdin || !process.stdout) {
        throw new Error('The spawned ACP process did not expose stdin/stdout streams.');
      }

      const readable = profile.filterStdoutLine
        ? createFilteredReadable(process.stdout, profile.filterStdoutLine)
        : process.stdout;
      const stream = ndJsonStream(
        Writable.toWeb(process.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(readable) as ReadableStream<Uint8Array>,
      );

      return new ClientSideConnection(() => client, stream) as never;
    },
  };
}

function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

function defaultSpawnProcess(command: string, args: string[], options: SpawnOptions): SpawnedProcess {
  const launch = resolveLaunch(command, args);
  return spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
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

function monitorProcess(process: SpawnedProcess, host: RuntimeHost): ProcessMonitor {
  let stderrBuffer = '';
  let exitSummary: string | null = null;

  process.stderr?.on('data', (chunk) => {
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
  };

  const child = process as SpawnedProcess & {
    on?: (event: string, listener: (...args: never[]) => void) => void;
  };
  child.on?.('close', onExit as never);

  return {
    getStderr() {
      return stderrBuffer.trim();
    },
    getExitSummary() {
      return exitSummary;
    },
  };
}

async function withStartupDiagnostics<T>(
  promise: Promise<T>,
  monitor: ProcessMonitor,
  profile: AgentProfile,
  label: string,
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw enhanceStartupError(error, monitor, profile, label);
  }
}

function enhanceStartupError(
  error: unknown,
  monitor: ProcessMonitor,
  profile: AgentProfile,
  label: string,
): Error {
  const baseMessage = error instanceof Error ? error.message : String(error);
  const details: string[] = [
    `${label} failed for profile "${profile.id}".`,
    baseMessage,
  ];

  const exitSummary = monitor.getExitSummary();
  if (exitSummary) {
    details.push(`Process: ${exitSummary}`);
  }

  const stderr = monitor.getStderr();
  if (stderr) {
    details.push(`stderr:\n${stderr}`);
  }

  if (error instanceof Error) {
    error.message = details.join('\n\n');
    return error;
  }

  const wrapped = new Error(details.join('\n\n')) as Error & { code?: unknown; data?: unknown };
  if (error && typeof error === 'object') {
    const source = error as { code?: unknown; data?: unknown };
    if (source.code !== undefined) wrapped.code = source.code;
    if (source.data !== undefined) wrapped.data = source.data;
  }
  return wrapped;
}

function quoteWindowsArgument(value: string): string {
  if (!value) return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function resolveLaunch(command: string, args: string[]) {
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

function createClientBridge(params: {
  host: RuntimeHost;
  getSessionId: () => string;
  onSessionUpdate: (notification: SessionNotification) => void;
}): Client {
  return {
    sessionUpdate: async (notification) => {
      params.onSessionUpdate(notification);
    },
    requestPermission: async (request) => handlePermissionRequest(params.host, params.getSessionId(), request),
    readTextFile: async (request) => delegateOrThrow(params.host.readTextFile, request, 'readTextFile'),
    writeTextFile: async (request) => delegateOrThrow(params.host.writeTextFile, request, 'writeTextFile'),
    createTerminal: async (request) => delegateOrThrow(params.host.createTerminal, request, 'createTerminal'),
    terminalOutput: async (request) => delegateOrThrow(params.host.terminalOutput, request, 'terminalOutput'),
    waitForTerminalExit: async (request) => delegateOrThrow(params.host.waitForTerminalExit, request, 'waitForTerminalExit'),
    killTerminal: async (request) => delegateOrThrow(params.host.killTerminal, request, 'killTerminal'),
    releaseTerminal: async (request) => delegateOrThrow(params.host.releaseTerminal, request, 'releaseTerminal'),
  };
}

async function delegateOrThrow<TRequest, TResponse>(
  handler: ((request: TRequest) => Promise<TResponse>) | undefined,
  request: TRequest,
  name: string,
): Promise<TResponse> {
  if (!handler) {
    throw new Error(`Host does not implement ${name}().`);
  }
  return handler(request);
}

async function handlePermissionRequest(
  host: RuntimeHost,
  sessionId: string,
  request: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  const options = Array.isArray((request as { options?: unknown[] }).options)
    ? ((request as { options: Array<{ optionId?: string; name?: string; kind?: string }> }).options)
    : [];
  const toolCall = (request as {
    toolCall?: {
      id?: string;
      toolName?: string;
      kind?: string;
      input?: unknown;
      arguments?: unknown;
      content?: unknown;
    };
  }).toolCall;
  const toolCallId = toolCall?.id || 'unknown-tool-call';
  const toolName = toolCall?.toolName || toolCall?.kind || 'tool';
  const input = toolCall?.input ?? toolCall?.arguments ?? toolCall?.content;

  const decision = host.requestPermission
    ? await host.requestPermission({
      sessionId,
      toolCallId,
      toolName,
      input,
      options,
      raw: request,
    })
    : 'deny';

  return {
    outcome: {
      outcome: 'selected',
      optionId: selectPermissionOptionId(decision, options),
    },
  };
}

function selectPermissionOptionId(
  decision: 'allow_once' | 'allow_always' | 'deny',
  options: Array<{ optionId?: string; name?: string }>,
): string {
  const normalizedDecision = decision || 'deny';
  if (normalizedDecision === 'allow_always') {
    return options.find((option) => option.optionId === 'proceed_always')?.optionId
      || options.find((option) => /always/i.test(option.name || ''))?.optionId
      || selectPermissionOptionId('allow_once', options);
  }
  if (normalizedDecision === 'allow_once') {
    return options.find((option) => option.optionId === 'proceed_once')?.optionId
      || options.find((option) => /once/i.test(option.name || ''))?.optionId
      || options[0]?.optionId
      || 'proceed_once';
  }
  return options.find((option) => option.optionId === 'cancel')?.optionId
    || options.find((option) => /cancel|deny/i.test(option.name || ''))?.optionId
    || 'cancel';
}

async function chooseAuthMethod(host: RuntimeHost, methods: AuthMethod[]): Promise<string | null> {
  if (methods.length === 0) {
    return null;
  }
  if (host.chooseAuthMethod) {
    return host.chooseAuthMethod({ methods });
  }
  return methods[0]?.id || null;
}

function isAuthRequiredError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown; data?: { message?: unknown; details?: unknown } };
  if (candidate.code === -32000) {
    return true;
  }
  const text = [candidate.message, candidate.data?.message, candidate.data?.details]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' | ');
  return /auth/.test(text) && /require/.test(text);
}

function looksLikeModeState(value: unknown): value is SessionModeState {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { availableModes?: unknown[] }).availableModes));
}

function looksLikeModelState(value: unknown): value is SessionModelState {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { availableModels?: unknown[] }).availableModels));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
