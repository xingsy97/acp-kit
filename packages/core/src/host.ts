import type {
  AuthMethod,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';

export interface RuntimeLogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

export interface RuntimePermissionRequest {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  options: Array<{
    optionId?: string;
    name?: string;
    kind?: string;
  }>;
  raw: RequestPermissionRequest;
}

export interface RuntimeAuthSelectionRequest {
  methods: AuthMethod[];
}

/** Direction of an ACP wire frame relative to the host (`out` = host → agent). */
export type WireDirection = 'in' | 'out';

/** Context passed to each `WireMiddleware`. `frame` is mutable. */
export interface WireContext {
  direction: WireDirection;
  /**
   * The JSON-RPC frame as a plain JS object (already parsed). Mutate in place
   * or reassign to rewrite what reaches the next middleware / the wire.
   */
  frame: unknown;
}

/**
 * Koa-style middleware run for every ACP frame in either direction.
 * Call `await next()` to forward; do not call it to drop the frame.
 *
 * Example (logger): `async (ctx, next) => { console.log(ctx.direction, ctx.frame); await next(); }`
 * Example (drop):   `async (ctx, next) => { if (isPing(ctx.frame)) return; await next(); }`
 * Example (rewrite):`async (ctx, next) => { ctx.frame = redact(ctx.frame); await next(); }`
 */
export type WireMiddleware = (ctx: WireContext, next: () => Promise<void>) => Promise<void> | void;

/** Reported by the node child-process transport when the agent process exits. */
export interface RuntimeAgentExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Last <=32KB of stderr captured before exit, trimmed. */
  stderr: string;
}

export interface RuntimeHost {
  chooseAuthMethod?(request: RuntimeAuthSelectionRequest): Promise<string | null>;
  requestPermission?(request: RuntimePermissionRequest): Promise<PermissionDecision>;
  readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  createTerminal?(params: CreateTerminalRequest): Promise<CreateTerminalResponse>;
  terminalOutput?(params: TerminalOutputRequest): Promise<TerminalOutputResponse>;
  waitForTerminalExit?(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse>;
  killTerminal?(params: KillTerminalRequest): Promise<KillTerminalResponse>;
  releaseTerminal?(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse>;
  log?(entry: RuntimeLogEvent): void;
  /**
   * Koa-style middleware chain run for every ACP wire frame in either direction.
   * Each middleware can observe, mutate (`ctx.frame = ...`), or drop (don't call `next`)
   * the frame before it reaches the next middleware or the underlying transport.
   * Provide a single function or an array (executed in order).
   */
  wireMiddleware?: WireMiddleware | WireMiddleware[];
  /**
   * Notification that the agent child process exited. Only invoked by the
   * default node transport; custom transports can call it as well.
   */
  onAgentExit?(info: RuntimeAgentExitInfo): void;
}
