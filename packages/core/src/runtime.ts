import { spawn } from 'node:child_process';
import { PassThrough, Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AgentCapabilities,
  type AuthMethod,
  type Client,
  type Implementation,
  type InitializeResponse,
  type McpServer,
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
    loadSession?(params: Record<string, unknown>): Promise<{
      configOptions?: unknown[];
      modes?: unknown;
      models?: unknown;
    } | undefined>;
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
  /** MCP servers to advertise to the agent for this session. */
  mcpServers?: McpServer[];
}

export interface LoadSessionOptions {
  /** The ACP session id previously returned by `acp.newSession(...).sessionId`. */
  sessionId: string;
  /** The working directory for the resumed session. Required unless the runtime has a default `cwd`. */
  cwd?: string;
  /** MCP servers to advertise to the agent for this session. */
  mcpServers?: McpServer[];
}

interface ProcessMonitor {
  getStderr(): string;
  getExitSummary(): string | null;
}

interface ConnectionState {
  process: SpawnedProcess;
  monitor: ProcessMonitor;
  connection: ReturnType<AcpConnectionFactory['create']>;
  initResponse: InitializeResponse;
  sessionsById: Map<string, RuntimeSession>;
  sessionUpdateRouter: (notification: SessionNotification) => void;
}

export class AcpRuntime {
  private readonly profile: AgentProfile;
  private readonly cwd: string | undefined;
  private readonly host: RuntimeHost;
  private readonly spawnProcess: SpawnProcess;
  private readonly connectionFactory: AcpConnectionFactory;
  private connectPromise: Promise<ConnectionState> | null = null;
  private connectionState: ConnectionState | null = null;
  private shutdownStarted = false;

  constructor(options: RuntimeOptions) {
    this.profile = resolveAgentProfile(options.profile);
    this.cwd = options.cwd;
    this.host = options.host;
    this.spawnProcess = options.spawnProcess || defaultSpawnProcess;
    this.connectionFactory = options.connectionFactory || createSdkConnectionFactory();
  }

  /** Information reported by the agent during `initialize`. `null` until the first session is created. */
  get agentInfo(): Implementation | null {
    return this.connectionState?.initResponse.agentInfo ?? null;
  }

  /** Authentication methods advertised by the agent. Empty array until the first session is created. */
  get authMethods(): readonly AuthMethod[] {
    return this.connectionState?.initResponse.authMethods ?? [];
  }

  /** Capabilities advertised by the agent (e.g. `loadSession`). `null` until the first session is created. */
  get agentCapabilities(): AgentCapabilities | null {
    return this.connectionState?.initResponse.agentCapabilities ?? null;
  }

  /** Protocol version negotiated with the agent. `null` until the first session is created. */
  get protocolVersion(): number | null {
    const v = this.connectionState?.initResponse.protocolVersion;
    return typeof v === 'number' ? v : null;
  }

  /** True once the agent process has been spawned and `initialize` completed. */
  get isReady(): boolean {
    return this.connectionState !== null;
  }

  /**
   * Spawn the agent process and complete the ACP `initialize` handshake. Idempotent.
   * Most users do not need to call this directly; `newSession` / `loadSession` will call it for you.
   */
  async ready(): Promise<void> {
    await this.connect();
  }

  async newSession(options: NewSessionOptions = {}): Promise<RuntimeSession> {
    const cwd = this.requireCwd(options.cwd, 'newSession');
    const state = await this.connect();
    const startupTimeoutMs = this.profile.startupTimeoutMs || 30000;

    const sessionResponse = await withAuthRetry({
      operation: () => withStartupDiagnostics(
        withTimeout(
          state.connection.newSession({
            cwd,
            mcpServers: options.mcpServers || [],
          }),
          startupTimeoutMs,
          'ACP session/new',
        ),
        state.monitor,
        this.profile,
        'ACP session/new',
      ),
      authMethods: state.initResponse.authMethods || [],
      authenticate: state.connection.authenticate?.bind(state.connection),
      host: this.host,
      monitor: state.monitor,
      profile: this.profile,
      timeoutMs: startupTimeoutMs,
    });

    const session = this.adoptSession({
      state,
      sessionId: sessionResponse.sessionId,
      modes: sessionResponse.modes,
      models: sessionResponse.models,
      configOptions: sessionResponse.configOptions,
    });

    return session;
  }

  /**
   * Resume a previously created ACP session by id. Requires the agent to advertise the
   * `loadSession` capability (see `acp.agentCapabilities`).
   */
  async loadSession(options: LoadSessionOptions): Promise<RuntimeSession> {
    if (!options.sessionId) {
      throw new Error('loadSession requires a `sessionId`.');
    }
    const cwd = this.requireCwd(options.cwd, 'loadSession');
    const state = await this.connect();
    if (typeof state.connection.loadSession !== 'function') {
      throw new Error('The ACP connection does not support loadSession.');
    }
    if (!state.initResponse.agentCapabilities?.loadSession) {
      throw new Error(
        `Agent "${this.profile.id}" does not advertise the loadSession capability. `
        + 'Inspect `acp.agentCapabilities.loadSession` before calling loadSession().',
      );
    }
    const startupTimeoutMs = this.profile.startupTimeoutMs || 30000;

    const loadResponse = await withAuthRetry({
      operation: () => withStartupDiagnostics(
        withTimeout(
          (state.connection.loadSession as NonNullable<typeof state.connection.loadSession>)({
            sessionId: options.sessionId,
            cwd,
            mcpServers: options.mcpServers || [],
          }),
          startupTimeoutMs,
          'ACP session/load',
        ),
        state.monitor,
        this.profile,
        'ACP session/load',
      ),
      authMethods: state.initResponse.authMethods || [],
      authenticate: state.connection.authenticate?.bind(state.connection),
      host: this.host,
      monitor: state.monitor,
      profile: this.profile,
      timeoutMs: startupTimeoutMs,
    });

    const session = this.adoptSession({
      state,
      sessionId: options.sessionId,
      modes: loadResponse?.modes,
      models: loadResponse?.models,
      configOptions: loadResponse?.configOptions,
    });

    return session;
  }

  /**
   * Dispose every session created by this runtime, then close the agent process. Idempotent.
   * After shutdown, `newSession` and `loadSession` throw.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    const errors: unknown[] = [];

    if (this.connectionState) {
      const sessions = [...this.connectionState.sessionsById.values()];
      for (const session of sessions) {
        try {
          await session.dispose();
        } catch (err) {
          errors.push(err);
        }
      }
      this.connectionState.sessionsById.clear();
      try {
        await this.connectionState.connection.dispose?.();
      } catch (err) {
        errors.push(err);
      }
      try {
        this.connectionState.process.kill();
      } catch {
        /* process may already be gone */
      }
      this.connectionState = null;
    }
    this.connectPromise = null;

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors as Error[], `${errors.length} resources failed to dispose cleanly.`);
    }
  }

  /** ES Explicit Resource Management: enables `await using acp = createAcpRuntime(...)`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  private requireCwd(cwd: string | undefined, methodName: string): string {
    if (this.shutdownStarted) {
      throw new Error(`Cannot call ${methodName}: runtime has been shut down.`);
    }
    const resolved = cwd || this.cwd;
    if (!resolved) {
      throw new Error(
        `${methodName} requires a \`cwd\`. Either pass \`{ cwd }\` or provide a default \`cwd\` to createAcpRuntime.`,
      );
    }
    return resolved;
  }

  private async connect(): Promise<ConnectionState> {
    if (this.shutdownStarted) {
      throw new Error('Cannot connect: runtime has been shut down.');
    }
    if (this.connectionState) return this.connectionState;
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect().catch((err) => {
        this.connectPromise = null;
        throw err;
      });
    }
    return this.connectPromise;
  }

  private async doConnect(): Promise<ConnectionState> {
    const sessionsById = new Map<string, RuntimeSession>();
    const sessionUpdateRouter = (notification: SessionNotification) => {
      const sessionId = (notification as { sessionId?: string }).sessionId;
      if (!sessionId) return;
      sessionsById.get(sessionId)?.handleSessionUpdate(notification);
    };

    const child = this.spawnProcess(this.profile.command, this.profile.args, {
      cwd: this.cwd || process.cwd(),
      env: {
        ...processEnv(),
        ...this.profile.env,
      },
    });
    const monitor = monitorProcess(child, this.host);

    const client = createClientBridge({
      host: this.host,
      onSessionUpdate: sessionUpdateRouter,
    });

    const connection = this.connectionFactory.create({
      client,
      process: child,
      profile: this.profile,
    });

    const startupTimeoutMs = this.profile.startupTimeoutMs || 30000;
    const initResponse = await withStartupDiagnostics(
      withTimeout(
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: {
            name: '@acp-kit/core',
            version: '0.1.3',
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

    const state: ConnectionState = {
      process: child,
      monitor,
      connection,
      initResponse,
      sessionsById,
      sessionUpdateRouter,
    };
    this.connectionState = state;
    return state;
  }

  private adoptSession(params: {
    state: ConnectionState;
    sessionId: string;
    modes: unknown;
    models: unknown;
    configOptions: unknown;
  }): RuntimeSession {
    const initialEvents = createInitialSessionEvents({
      sessionId: params.sessionId,
      configOptions: Array.isArray(params.configOptions) ? params.configOptions as never : undefined,
      modes: looksLikeModeState(params.modes) ? params.modes : undefined,
      models: looksLikeModelState(params.models) ? params.models : undefined,
    });

    const session = new RuntimeSession({
      sessionId: params.sessionId,
      profile: this.profile,
      host: this.host,
      connection: params.state.connection,
      initialEvents,
    });

    params.state.sessionsById.set(params.sessionId, session);
    const originalDispose = session.dispose.bind(session);
    session.dispose = async () => {
      try {
        await originalDispose();
      } finally {
        params.state.sessionsById.delete(params.sessionId);
      }
    };

    return session;
  }
}

interface AuthRetryParams<T> {
  operation: () => Promise<T>;
  authMethods: readonly AuthMethod[];
  authenticate: ((params: { methodId: string }) => Promise<unknown>) | undefined;
  host: RuntimeHost;
  monitor: ProcessMonitor;
  profile: AgentProfile;
  timeoutMs: number;
}

/** Run `operation`; if it fails with `auth_required`, run the chosen auth method, then retry once. */
async function withAuthRetry<T>(params: AuthRetryParams<T>): Promise<T> {
  try {
    return await params.operation();
  } catch (error) {
    if (!isAuthRequiredError(error)) throw error;

    const methodId = await chooseAuthMethod(params.host, [...params.authMethods]);
    if (!methodId) {
      throw new Error('Authentication was required but no auth method was selected.');
    }
    if (typeof params.authenticate !== 'function') {
      throw new Error('Authentication is required, but the ACP connection does not support authenticate().');
    }

    await withStartupDiagnostics(
      withTimeout(
        params.authenticate({ methodId }),
        params.timeoutMs,
        'ACP authenticate',
      ),
      params.monitor,
      params.profile,
      'ACP authenticate',
    );

    return params.operation();
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
  onSessionUpdate: (notification: SessionNotification) => void;
}): Client {
  return {
    sessionUpdate: async (notification) => {
      params.onSessionUpdate(notification);
    },
    requestPermission: async (request) => handlePermissionRequest(
      params.host,
      (request as { sessionId?: string }).sessionId || '',
      request,
    ),
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
