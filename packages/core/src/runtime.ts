import {
  PROTOCOL_VERSION,
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
import { isAcpAuthRequired } from './errors.js';
import { resolveAgentProfile, type AgentProfile, type BuiltInProfileId } from './profiles.js';
import { RuntimeSession, createInitialSessionEvents, type AcpConnectionLike } from './session.js';
import type {
  AcpConnectionFactory,
  SpawnProcess,
} from './transports/node.js';

/* ------------------------------------------------------------------------- */
/* Transport contract                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Connection produced by an {@link AcpTransport}. Extends the per-session
 * {@link AcpConnectionLike} surface with the connection-level methods used
 * by the runtime during initialize / new session / load session / auth /
 * setMode / setModel.
 */
export interface AcpTransportConnection extends AcpConnectionLike {
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
  setSessionMode?(params: { sessionId: string; modeId: string }): Promise<unknown>;
  unstable_setSessionModel?(params: { sessionId: string; modelId: string }): Promise<unknown>;
}

export interface AcpTransportSession {
  connection: AcpTransportConnection;
  /** Optional diagnostic hook; the runtime calls this when enriching startup errors. */
  getDiagnostics?(): { stderr: string; exitSummary: string | null };
}

/**
 * Transport abstraction. Owns the underlying transport (child process, IPC,
 * websocket, etc.) and produces an {@link AcpTransportConnection} ready for
 * `initialize`. The runtime owns the lifecycle of the returned session via
 * `connection.dispose()`.
 */
export interface AcpTransport {
  connect(params: {
    profile: AgentProfile;
    host: RuntimeHost;
    client: Client;
    cwd: string | undefined;
    onSessionUpdate: (notification: SessionNotification) => void;
  }): Promise<AcpTransportSession>;
}

/* ------------------------------------------------------------------------- */
/* Runtime options                                                            */
/* ------------------------------------------------------------------------- */

export interface RuntimeOptions {
  profile: AgentProfile | BuiltInProfileId;
  /**
   * Optional default working directory for sessions created via `newSession()` without an explicit `cwd`.
   * If omitted, callers MUST provide `cwd` to every `newSession({ cwd })` call.
   */
  cwd?: string;
  host: RuntimeHost;
  /**
   * Pluggable transport. Defaults to the node child-process transport
   * (`@acp-kit/core/node` → `nodeChildProcessTransport`). Browser/Webview hosts
   * should provide their own transport that bridges to the underlying IPC.
   */
  transport?: AcpTransport;
  /** @deprecated Provide a custom `transport` instead. Forwarded to the default node transport when set. */
  spawnProcess?: SpawnProcess;
  /** @deprecated Provide a custom `transport` instead. Forwarded to the default node transport when set. */
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

interface ConnectionState {
  transportSession: AcpTransportSession;
  connection: AcpTransportConnection;
  initResponse: InitializeResponse;
  sessionsById: Map<string, RuntimeSession>;
  sessionUpdateRouter: (notification: SessionNotification) => void;
}

/* ------------------------------------------------------------------------- */
/* AcpRuntime                                                                 */
/* ------------------------------------------------------------------------- */

export class AcpRuntime {
  private readonly profile: AgentProfile;
  private readonly cwd: string | undefined;
  private readonly host: RuntimeHost;
  private readonly explicitTransport: AcpTransport | undefined;
  private readonly legacySpawnProcess: SpawnProcess | undefined;
  private readonly legacyConnectionFactory: AcpConnectionFactory | undefined;
  private connectPromise: Promise<ConnectionState> | null = null;
  private connectionState: ConnectionState | null = null;
  private shutdownStarted = false;

  constructor(options: RuntimeOptions) {
    this.profile = resolveAgentProfile(options.profile);
    this.cwd = options.cwd;
    this.host = options.host;
    this.explicitTransport = options.transport;
    this.legacySpawnProcess = options.spawnProcess;
    this.legacyConnectionFactory = options.connectionFactory;
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

  /** True once the transport has connected and `initialize` completed. */
  get isReady(): boolean {
    return this.connectionState !== null;
  }

  /**
   * Connect the transport and complete the ACP `initialize` handshake. Idempotent.
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
        state.transportSession,
        this.profile,
        'ACP session/new',
      ),
      authMethods: state.initResponse.authMethods || [],
      authenticate: state.connection.authenticate?.bind(state.connection),
      host: this.host,
      transportSession: state.transportSession,
      profile: this.profile,
      timeoutMs: startupTimeoutMs,
    });

    return this.adoptSession({
      state,
      sessionId: sessionResponse.sessionId,
      modes: sessionResponse.modes,
      models: sessionResponse.models,
      configOptions: sessionResponse.configOptions,
    });
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
        state.transportSession,
        this.profile,
        'ACP session/load',
      ),
      authMethods: state.initResponse.authMethods || [],
      authenticate: state.connection.authenticate?.bind(state.connection),
      host: this.host,
      transportSession: state.transportSession,
      profile: this.profile,
      timeoutMs: startupTimeoutMs,
    });

    return this.adoptSession({
      state,
      sessionId: options.sessionId,
      modes: loadResponse?.modes,
      models: loadResponse?.models,
      configOptions: loadResponse?.configOptions,
    });
  }

  /**
   * Tear down the current transport session (and any ACP sessions on it) without
   * shutting the runtime down. The next call to `newSession`/`loadSession` will
   * reconnect transparently. External references to the runtime stay valid;
   * external references to prior {@link RuntimeSession} instances do not
   * (they will be in `disposed` status).
   */
  async reconnect(): Promise<void> {
    if (this.shutdownStarted) {
      throw new Error('Cannot reconnect: runtime has been shut down.');
    }
    if (!this.connectionState && !this.connectPromise) {
      return; // never connected, nothing to do
    }
    await this.teardownConnection();
  }

  /**
   * Dispose every session created by this runtime, then close the agent process. Idempotent.
   * After shutdown, `newSession` and `loadSession` throw.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    await this.teardownConnection();
  }

  /** ES Explicit Resource Management: enables `await using acp = createAcpRuntime(...)`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  private async teardownConnection(): Promise<void> {
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
      this.connectionState = null;
    }
    this.connectPromise = null;

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors as Error[], `${errors.length} resources failed to dispose cleanly.`);
    }
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

    const transport = await this.resolveTransport();
    const client = createClientBridge({
      host: this.host,
      onSessionUpdate: sessionUpdateRouter,
    });

    const transportSession = await transport.connect({
      profile: this.profile,
      host: this.host,
      client,
      cwd: this.cwd,
      onSessionUpdate: sessionUpdateRouter,
    });

    const startupTimeoutMs = this.profile.startupTimeoutMs || 30000;
    const initResponse = await withStartupDiagnostics(
      withTimeout(
        transportSession.connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: {
            name: '@acp-kit/core',
            version: '0.1.4',
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
      transportSession,
      this.profile,
      'ACP initialize',
    );

    const state: ConnectionState = {
      transportSession,
      connection: transportSession.connection,
      initResponse,
      sessionsById,
      sessionUpdateRouter,
    };
    this.connectionState = state;
    return state;
  }

  private async resolveTransport(): Promise<AcpTransport> {
    if (this.explicitTransport) {
      return this.explicitTransport;
    }
    const { nodeChildProcessTransport } = await import('./transports/node.js');
    return nodeChildProcessTransport({
      spawnProcess: this.legacySpawnProcess,
      connectionFactory: this.legacyConnectionFactory,
    });
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

/* ------------------------------------------------------------------------- */
/* Auth retry                                                                 */
/* ------------------------------------------------------------------------- */

interface AuthRetryParams<T> {
  operation: () => Promise<T>;
  authMethods: readonly AuthMethod[];
  authenticate: ((params: { methodId: string }) => Promise<unknown>) | undefined;
  host: RuntimeHost;
  transportSession: AcpTransportSession;
  profile: AgentProfile;
  timeoutMs: number;
}

/** Run `operation`; if it fails with `auth_required`, run the chosen auth method, then retry once. */
async function withAuthRetry<T>(params: AuthRetryParams<T>): Promise<T> {
  try {
    return await params.operation();
  } catch (error) {
    if (!isAcpAuthRequired(error)) throw error;

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
      params.transportSession,
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

/* ------------------------------------------------------------------------- */
/* Diagnostic + utility helpers                                               */
/* ------------------------------------------------------------------------- */

async function withStartupDiagnostics<T>(
  promise: Promise<T>,
  transportSession: AcpTransportSession,
  profile: AgentProfile,
  label: string,
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw enhanceStartupError(error, transportSession, profile, label);
  }
}

function enhanceStartupError(
  error: unknown,
  transportSession: AcpTransportSession,
  profile: AgentProfile,
  label: string,
): Error {
  const baseMessage = error instanceof Error ? error.message : String(error);
  const details: string[] = [
    `${label} failed for profile "${profile.id}".`,
    baseMessage,
  ];

  const diagnostics = transportSession.getDiagnostics?.();
  if (diagnostics?.exitSummary) {
    details.push(`Process: ${diagnostics.exitSummary}`);
  }
  if (diagnostics?.stderr) {
    details.push(`stderr:\n${diagnostics.stderr}`);
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
      title?: string;
      input?: unknown;
      arguments?: unknown;
      content?: unknown;
    };
  }).toolCall;
  const toolCallId = toolCall?.id || 'unknown-tool-call';
  const toolName = toolCall?.toolName || toolCall?.kind || 'tool';
  const title = toolCall?.title || '';
  const input = toolCall?.input ?? toolCall?.arguments ?? toolCall?.content;

  const decision = host.requestPermission
    ? await host.requestPermission({
      sessionId,
      toolCallId,
      toolName,
      title,
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

function looksLikeModeState(value: unknown): value is SessionModeState {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { availableModes?: unknown[] }).availableModes));
}

function looksLikeModelState(value: unknown): value is SessionModelState {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { availableModels?: unknown[] }).availableModels));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
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
