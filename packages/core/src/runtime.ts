import {
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AuthMethod,
  type Client,
  type Implementation,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionModelState,
  type SessionModeState,
  type SessionNotification,
} from '@agentclientprotocol/sdk';

// Read at build time so the value matches whatever package.json the consumer installs.
// Updated when the package version changes; safe to read once at module init.
import { CORE_PACKAGE_NAME, CORE_PACKAGE_VERSION } from './package-info.js';

import {
  PermissionDecision,
  type RuntimeHost,
  type RuntimePermissionRequest,
  type PermissionDecision as PermissionDecisionValue,
} from './host.js';
import { isAcpAuthRequired } from './errors.js';
import { type AgentProfile } from './agents.js';
import { RuntimeSession, createInitialSessionEvents, type AcpConnectionLike, type RuntimeSessionEvent } from './session.js';
import {
  createAcpStartupError,
  type AcpStartupFailurePhase,
  type AcpTransportDiagnostics,
} from './diagnostics.js';
import type { RuntimeInspector } from './inspector.js';
import {
  sessionEventToObservation,
  type RuntimeApprovalQueue,
  type RuntimeContext,
  type RuntimeEventStore,
  type RuntimeObservation,
  type RuntimeObservabilityOptions,
} from './enterprise-runtime.js';
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
  listSessions?(params: ListSessionsRequest): Promise<ListSessionsResponse>;
  unstable_closeSession?(params: { sessionId: string }): Promise<unknown>;
}

export interface AcpTransportSession {
  connection: AcpTransportConnection;
  /** Optional diagnostic hook; the runtime calls this when enriching startup errors. */
  getDiagnostics?(): AcpTransportDiagnostics;
}

/**
 * Transport abstraction. Owns the underlying transport (child process, IPC,
 * websocket, etc.) and produces an {@link AcpTransportConnection} ready for
 * `initialize`. The runtime owns the lifecycle of the returned session via
 * `connection.dispose()`.
 */
export interface AcpTransport {
  connect(params: {
    agent: AgentProfile;
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
  /**
   * Which agent to launch. Pass one of the built-in constants
   * ({@link GitHubCopilot}, {@link ClaudeCode}, {@link CodexCli},
   * {@link GeminiCli}, {@link QwenCode}, {@link OpenCode}) or a custom
   * {@link AgentProfile} literal.
   */
  agent: AgentProfile;
  /**
   * Optional default working directory for sessions created via `newSession()` without an explicit `cwd`.
   * If omitted, callers MUST provide `cwd` to every `newSession({ cwd })` call.
   */
  cwd?: string;
  /**
   * Host capabilities and policy hooks. Defaults to approving tool permissions once and selecting
   * the first offered auth method. Production applications should provide an explicit host policy.
   */
  host?: RuntimeHost;
  /** Correlation context copied onto observations and durable event-store entries. */
  context?: RuntimeContext;
  /** Structured runtime observation sink for tracing, metrics, and audit pipelines. */
  observability?: RuntimeObservabilityOptions;
  /** Durable append-only store for observations and normalized session events. */
  eventStore?: RuntimeEventStore;
  /** Session recording store. Receives the same append-only entries as `eventStore` and is intended for replay/debugging. */
  recording?: RuntimeEventStore;
  /** Optional human approval queue used for ACP permission requests. */
  approvals?: RuntimeApprovalQueue;
  /** Runtime inspector that receives observations and, when enabled, ACP wire frames. */
  inspector?: RuntimeInspector;
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

const defaultRuntimeHost: RuntimeHost = {
  requestPermission: async () => PermissionDecision.AllowOnce,
  chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
};

function mergeInspectorHost(host: RuntimeHost, inspector: RuntimeInspector | undefined): RuntimeHost {
  if (!inspector?.wireMiddleware) return host;
  const existing = host.wireMiddleware;
  return {
    ...host,
    wireMiddleware: existing
      ? Array.isArray(existing) ? [...existing, inspector.wireMiddleware] : [existing, inspector.wireMiddleware]
      : inspector.wireMiddleware,
  };
}

function newRuntimeId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return cryptoApi?.randomUUID?.() ?? `runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------------- */
/* AcpRuntime                                                                 */
/* ------------------------------------------------------------------------- */

export class AcpRuntime {
  readonly runtimeId: string;

  private readonly agent: AgentProfile;
  private readonly cwd: string | undefined;
  private readonly host: RuntimeHost;
  private readonly context: RuntimeContext | undefined;
  private readonly observability: RuntimeObservabilityOptions | undefined;
  private readonly eventStore: RuntimeEventStore | undefined;
  private readonly recording: RuntimeEventStore | undefined;
  private readonly approvals: RuntimeApprovalQueue | undefined;
  private readonly inspector: RuntimeInspector | undefined;
  private readonly explicitTransport: AcpTransport | undefined;
  private readonly legacySpawnProcess: SpawnProcess | undefined;
  private readonly legacyConnectionFactory: AcpConnectionFactory | undefined;
  private connectPromise: Promise<ConnectionState> | null = null;
  private connectionState: ConnectionState | null = null;
  private shutdownStarted = false;

  constructor(options: RuntimeOptions) {
    this.runtimeId = newRuntimeId();
    this.agent = {
      ...options.agent,
      args: [...options.agent.args],
      env: options.agent.env ? { ...options.agent.env } : undefined,
    };
    this.cwd = options.cwd;
    this.inspector = options.inspector;
    this.host = mergeInspectorHost(options.host ?? defaultRuntimeHost, options.inspector);
    this.context = options.context ? { ...options.context } : undefined;
    this.observability = options.observability;
    this.eventStore = options.eventStore;
    this.recording = options.recording;
    this.approvals = options.approvals;
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
   * List sessions known to the agent via ACP `session/list`. Requires the agent
   * to advertise the `sessionCapabilities.list` capability
   * (see {@link AcpRuntime.agentCapabilities}); throws otherwise.
   *
   * Pagination is cursor-based: pass the previous response's `nextCursor` to
   * fetch the next page.
   */
  async listSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    const state = await this.connect();
    const sessionCapabilities = state.initResponse.agentCapabilities?.sessionCapabilities;
    if (!sessionCapabilities?.list) {
      throw new Error(
        `Agent "${this.agent.id}" does not advertise the session/list capability. `
        + 'Inspect `acp.agentCapabilities.sessionCapabilities?.list` before calling listSessions().',
      );
    }
    if (typeof state.connection.listSessions !== 'function') {
      throw new Error('The ACP connection does not support listSessions.');
    }
    return state.connection.listSessions(params);
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
    const startupTimeoutMs = this.agent.startupTimeoutMs || 30000;

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
        this.agent,
        'ACP session/new',
        'session-new',
        cwd,
      ),
      authMethods: state.initResponse.authMethods || [],
      authenticate: state.connection.authenticate?.bind(state.connection),
      host: this.host,
      transportSession: state.transportSession,
      agent: this.agent,
      timeoutMs: startupTimeoutMs,
    });

    return this.adoptSession({
      state,
      sessionId: sessionResponse.sessionId,
      modes: sessionResponse.modes,
      models: sessionResponse.models,
      configOptions: sessionResponse.configOptions,
      cwd,
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
        `Agent "${this.agent.id}" does not advertise the loadSession capability. `
        + 'Inspect `acp.agentCapabilities.loadSession` before calling loadSession().',
      );
    }
    const startupTimeoutMs = this.agent.startupTimeoutMs || 30000;

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
        this.agent,
        'ACP session/load',
        'session-load',
        cwd,
      ),
      authMethods: state.initResponse.authMethods || [],
      authenticate: state.connection.authenticate?.bind(state.connection),
      host: this.host,
      transportSession: state.transportSession,
      agent: this.agent,
      timeoutMs: startupTimeoutMs,
    });

    return this.adoptSession({
      state,
      sessionId: options.sessionId,
      modes: loadResponse?.modes,
      models: loadResponse?.models,
      configOptions: loadResponse?.configOptions,
      loaded: true,
      cwd,
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
    const startedAt = Date.now();
    this.recordObservation({ type: 'runtime.shutdown.started', at: startedAt });
    await this.teardownConnection();
    this.recordObservation({
      type: 'runtime.shutdown.completed',
      at: Date.now(),
      durationMs: Date.now() - startedAt,
    });
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
    const startedAt = Date.now();
    this.recordObservation({ type: 'runtime.connect.started', at: startedAt });
    const sessionsById = new Map<string, RuntimeSession>();
    const sessionUpdateRouter = (notification: SessionNotification) => {
      const sessionId = (notification as { sessionId?: string }).sessionId;
      if (!sessionId) return;
      sessionsById.get(sessionId)?.handleSessionUpdate(notification);
    };

    try {
      const transport = await this.resolveTransport();
      const client = createClientBridge({
        host: this.host,
        runtimeId: this.runtimeId,
        agent: this.agent,
        context: this.context,
        approvals: this.approvals,
        observe: (observation) => this.recordObservation(observation),
        onSessionUpdate: sessionUpdateRouter,
      });

      const transportSession = await transport.connect({
        agent: this.agent,
        host: this.host,
        client,
        cwd: this.cwd,
        onSessionUpdate: sessionUpdateRouter,
      });

      const startupTimeoutMs = this.agent.startupTimeoutMs || 30000;
      const promptCapabilities = this.host.promptCapabilities;
      const initResponse = await withStartupDiagnostics(
        withTimeout(
          transportSession.connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: {
              name: CORE_PACKAGE_NAME,
              version: CORE_PACKAGE_VERSION,
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
              ...(promptCapabilities ? {
                promptCapabilities: {
                  image: !!promptCapabilities.image,
                  audio: !!promptCapabilities.audio,
                  embeddedContext: !!promptCapabilities.embeddedContext,
                },
              } : {}),
            },
          }),
          startupTimeoutMs,
          'ACP initialize',
        ),
        transportSession,
        this.agent,
        'ACP initialize',
        'initialize',
        this.cwd,
      );

      const state: ConnectionState = {
        transportSession,
        connection: transportSession.connection,
        initResponse,
        sessionsById,
        sessionUpdateRouter,
      };
      this.connectionState = state;
      this.recordObservation({
        type: 'runtime.connect.completed',
        at: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      return state;
    } catch (error) {
      this.recordObservation({
        type: 'runtime.connect.failed',
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
    loaded?: boolean;
    cwd?: string;
  }): RuntimeSession {
    const initialEvents = createInitialSessionEvents({
      sessionId: params.sessionId,
      configOptions: Array.isArray(params.configOptions) ? params.configOptions as never : undefined,
      modes: looksLikeModeState(params.modes) ? params.modes : undefined,
      models: looksLikeModelState(params.models) ? params.models : undefined,
    });

    const session = new RuntimeSession({
      sessionId: params.sessionId,
      agent: this.agent,
      host: this.host,
      connection: params.state.connection,
      initialEvents,
      onEvent: (event) => this.recordSessionEvent(event),
    });

    for (const event of initialEvents) {
      this.recordSessionEvent(event);
    }

    this.recordObservation({
      type: params.loaded ? 'session.loaded' : 'session.created',
      at: Date.now(),
      sessionId: params.sessionId,
      cwd: params.cwd,
    });

    params.state.sessionsById.set(params.sessionId, session);
    const originalDispose = session.dispose.bind(session);
    session.dispose = async () => {
      try {
        await originalDispose();
      } finally {
        params.state.sessionsById.delete(params.sessionId);
        this.recordObservation({
          type: 'session.disposed',
          at: Date.now(),
          sessionId: params.sessionId,
          cwd: params.cwd,
        });
      }
    };

    return session;
  }

  private recordSessionEvent(event: RuntimeSessionEvent): void {
    this.writeStore({
      kind: 'session.event',
      at: event.at,
      runtimeId: this.runtimeId,
      agentId: this.agent.id,
      context: this.context,
      sessionId: event.sessionId,
      event,
    });
    const observation = sessionEventToObservation({
      event,
      runtimeId: this.runtimeId,
      agent: this.agent,
      context: this.context,
    });
    if (observation) this.recordObservation(observation);
  }

  private recordObservation(
    observation: RuntimeObservation | ({ type: RuntimeObservation['type']; at: number } & Record<string, unknown>),
  ): void {
    const fullObservation = {
      ...observation,
      runtimeId: (observation as Partial<RuntimeObservation>).runtimeId ?? this.runtimeId,
      agentId: (observation as Partial<RuntimeObservation>).agentId ?? this.agent.id,
      context: (observation as Partial<RuntimeObservation>).context ?? this.context,
    } as RuntimeObservation;
    this.safeCall(() => this.observability?.sink?.(fullObservation), 'observability.sink');
    this.safeCall(() => this.inspector?.observe(fullObservation), 'inspector.observe');
    this.writeStore({
      kind: 'observation',
      at: fullObservation.at,
      runtimeId: this.runtimeId,
      agentId: this.agent.id,
      context: this.context,
      observation: fullObservation,
    });
  }

  private writeStore(entry: Parameters<NonNullable<RuntimeEventStore['append']>>[0]): void {
    this.safeCall(() => this.eventStore?.append(entry), 'eventStore.append');
    if (this.recording && this.recording !== this.eventStore) {
      this.safeCall(() => this.recording?.append(entry), 'recording.append');
    }
  }

  private safeCall(operation: () => void | Promise<void> | undefined, label: string): void {
    try {
      const result = operation();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch((error) => this.host.log?.({
          level: 'warn',
          message: `${label} failed.`,
          context: { error: error instanceof Error ? error.message : String(error) },
        }));
      }
    } catch (error) {
      this.host.log?.({
        level: 'warn',
        message: `${label} failed.`,
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    }
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
  agent: AgentProfile;
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
      params.agent,
      'ACP authenticate',
      'authenticate',
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
  agent: AgentProfile,
  label: string,
  phase?: AcpStartupFailurePhase,
  cwd?: string,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await promise;
  } catch (error) {
    if (isAcpAuthRequired(error)) throw error;
    throw createAcpStartupError({
      agent,
      label,
      phase,
      cwd,
      startedAt,
      error,
      transportDiagnostics: transportSession.getDiagnostics?.(),
    });
  }
}

function createClientBridge(params: {
  host: RuntimeHost;
  runtimeId: string;
  agent: AgentProfile;
  context?: RuntimeContext;
  approvals?: RuntimeApprovalQueue;
  observe: (observation: RuntimeObservation) => void;
  onSessionUpdate: (notification: SessionNotification) => void;
}): Client {
  return {
    sessionUpdate: async (notification) => {
      params.onSessionUpdate(notification);
    },
    requestPermission: async (request) => handlePermissionRequest(
      params.host,
      params.runtimeId,
      params.agent,
      params.context,
      params.approvals,
      params.observe,
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
  runtimeId: string,
  agent: AgentProfile,
  context: RuntimeContext | undefined,
  approvals: RuntimeApprovalQueue | undefined,
  observe: (observation: RuntimeObservation) => void,
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
  const requestedAt = Date.now();
  const baseObservation = {
    runtimeId,
    agentId: agent.id,
    context,
    sessionId,
    toolCallId,
    toolName,
  };

  observe({
    ...baseObservation,
    type: 'permission.requested',
    at: requestedAt,
    title,
  });

  try {
    const permissionRequest = {
      sessionId,
      toolCallId,
      toolName,
      title,
      input,
      options,
      raw: request,
    };
    const decision = approvals
      ? await requestApprovalDecision({
        approvals,
        request: permissionRequest,
        runtimeId,
        agent,
        context,
        requestedAt,
        observe,
      })
      : host.requestPermission
        ? await host.requestPermission(permissionRequest)
        : PermissionDecision.Deny;

    observe({
      ...baseObservation,
      type: 'permission.decided',
      at: Date.now(),
      decision,
    });

    return {
      outcome: {
        outcome: 'selected',
        optionId: selectPermissionOptionId(decision, options),
      },
    };
  } catch (error) {
    observe({
      ...baseObservation,
      type: 'permission.failed',
      at: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function requestApprovalDecision(params: {
  approvals: RuntimeApprovalQueue;
  request: RuntimePermissionRequest;
  runtimeId: string;
  agent: AgentProfile;
  context?: RuntimeContext;
  requestedAt: number;
  observe: (observation: RuntimeObservation) => void;
}): Promise<PermissionDecisionValue> {
  const approvalId = `approval:${params.request.toolCallId}:${params.requestedAt}`;
  const approvalRequest = {
    ...params.request,
    approvalId,
    runtimeId: params.runtimeId,
    agentId: params.agent.id,
    context: params.context,
    requestedAt: params.requestedAt,
  };
  const ticketLike = await params.approvals.request(approvalRequest);
  const ticket = typeof ticketLike === 'string'
    ? { approvalId: ticketLike }
    : ticketLike ?? { approvalId };
  params.observe({
    type: 'approval.queued',
    at: Date.now(),
    runtimeId: params.runtimeId,
    agentId: params.agent.id,
    context: params.context,
    sessionId: params.request.sessionId,
    toolCallId: params.request.toolCallId,
    toolName: params.request.toolName,
    approvalId: ticket.approvalId,
  });
  const decision = await params.approvals.waitForDecision(ticket);
  params.observe({
    type: 'approval.decided',
    at: Date.now(),
    runtimeId: params.runtimeId,
    agentId: params.agent.id,
    context: params.context,
    sessionId: params.request.sessionId,
    toolCallId: params.request.toolCallId,
    toolName: params.request.toolName,
    approvalId: ticket.approvalId,
    decision,
  });
  return decision;
}

function selectPermissionOptionId(
  decision: PermissionDecisionValue,
  options: Array<{ optionId?: string; name?: string }>,
): string {
  const normalizedDecision = decision || PermissionDecision.Deny;
  if (normalizedDecision === PermissionDecision.AllowAlways) {
    return options.find((option) => option.optionId === 'proceed_always')?.optionId
      || options.find((option) => /always/i.test(option.name || ''))?.optionId
      || selectPermissionOptionId(PermissionDecision.AllowOnce, options);
  }
  if (normalizedDecision === PermissionDecision.AllowOnce) {
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
