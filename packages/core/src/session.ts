import type { PromptResponse, SessionNotification } from '@agentclientprotocol/sdk';
import {
  applyRuntimeEvent,
  cloneTranscriptState,
  createTranscriptState,
  flushOpenStreamCompletions,
  normalizeAcpUpdate,
  type RuntimeEvent,
  type SessionConfigUpdatedEvent,
  type SessionModeUpdatedEvent,
  type SessionModesUpdatedEvent,
  type SessionModelUpdatedEvent,
  type SessionModelsUpdatedEvent,
  type TranscriptState,
} from './session-data.js';
import { onRuntimeEvent, type RuntimeEventHandlers } from './runtime-event.js';

import type { RuntimeHost } from './host.js';
import type { AgentProfile } from './profiles.js';

function newId(): string {
  // Web Crypto is available in Node >=19 and every modern browser/Webview.
  const c: { randomUUID?: () => string } | undefined = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback (should never trigger on supported runtimes); not cryptographically strong.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface AcpConnectionLike {
  prompt(params: { sessionId: string; prompt: Array<{ type: 'text'; text: string }> }): Promise<PromptResponse>;
  cancel(params: { sessionId: string }): Promise<void>;
  setSessionMode?(params: { sessionId: string; modeId: string }): Promise<unknown>;
  unstable_setSessionModel?(params: { sessionId: string; modelId: string }): Promise<unknown>;
  dispose?(): Promise<void>;
}

export type SessionStatus = 'idle' | 'running' | 'cancelling' | 'disposed';

export interface TurnStartedEvent {
  type: 'turn.started';
  sessionId: string;
  at: number;
  turnId: string;
}

export interface TurnCompletedEvent {
  type: 'turn.completed';
  sessionId: string;
  at: number;
  turnId: string;
  stopReason: string | null;
}

export interface TurnFailedEvent {
  type: 'turn.failed';
  sessionId: string;
  at: number;
  turnId: string;
  error: string;
}

export interface TurnCancelledEvent {
  type: 'turn.cancelled';
  sessionId: string;
  at: number;
  turnId: string;
  reason: string;
}

export interface StatusChangedEvent {
  type: 'status.changed';
  sessionId: string;
  at: number;
  status: SessionStatus;
  previousStatus: SessionStatus | null;
}

export type RuntimeSessionEvent =
  | RuntimeEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent
  | StatusChangedEvent;

export interface PromptResult {
  stopReason: string | null;
}

type Listener = (event: RuntimeSessionEvent) => void;

interface RuntimeSessionOptions {
  sessionId: string;
  profile: AgentProfile;
  host: RuntimeHost;
  connection: AcpConnectionLike;
  initialEvents?: RuntimeEvent[];
}

export class RuntimeSession {
  readonly sessionId: string;
  readonly profile: AgentProfile;

  private readonly host: RuntimeHost;
  private readonly connection: AcpConnectionLike;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly transcript = createTranscriptState();

  private status: SessionStatus = 'idle';
  private currentTurnId: string | null = null;
  private currentMessageId: string | null = null;
  private currentReasoningId: string | null = null;
  private cancelling = false;

  constructor(options: RuntimeSessionOptions) {
    this.sessionId = options.sessionId;
    this.profile = options.profile;
    this.host = options.host;
    this.connection = options.connection;

    for (const event of options.initialEvents || []) {
      applyRuntimeEvent(this.transcript, event);
    }
  }

  /**
   * Subscribe to events using a per-variant handler map. Handlers are keyed by
   * the camelCase form of the event type (`message.delta` → `messageDelta`,
   * `tool.start` → `toolStart`, `turn.completed` → `turnCompleted`, ...).
   * Each handler receives the matching event variant with full type narrowing.
   *
   * ```ts
   * session.on({
   *   messageDelta:  (e) => process.stdout.write(e.delta),
   *   toolStart:     (e) => console.log(`[${e.toolCallId}] ${e.title}`),
   *   turnCompleted: (e) => console.log(`done: ${e.stopReason}`),
   * });
   * ```
   */
  on(handlers: RuntimeEventHandlers<RuntimeSessionEvent>): () => void;
  /**
   * Subscribe to a specific event type. The listener parameter is narrowed to
   * the matching event variant (e.g. `'tool.start'` → `ToolStartEvent`), so
   * fields like `e.toolCallId` / `e.delta` are typed.
   */
  on<K extends RuntimeSessionEvent['type']>(
    type: K,
    listener: (event: Extract<RuntimeSessionEvent, { type: K }>) => void,
  ): () => void;
  /**
   * Subscribe to every event with the full `RuntimeSessionEvent` union.
   */
  on(type: 'event', listener: (event: RuntimeSessionEvent) => void): () => void;
  on(
    typeOrHandlers: RuntimeSessionEvent['type'] | 'event' | RuntimeEventHandlers<RuntimeSessionEvent>,
    listener?: Listener,
  ): () => void {
    if (typeof typeOrHandlers === 'object' && typeOrHandlers !== null) {
      const handlers = typeOrHandlers;
      return this.subscribe('event', (event) => {
        onRuntimeEvent(event, handlers);
      });
    }
    return this.subscribe(typeOrHandlers, listener as Listener);
  }

  private subscribe(type: string, listener: Listener): () => void {
    const listeners = this.listeners.get(type) || new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(type);
      }
    };
  }

  getSnapshot(): TranscriptState {
    return cloneTranscriptState(this.transcript);
  }

  async prompt(text: string): Promise<PromptResult> {
    if (this.status === 'disposed') {
      throw new Error('Session has already been disposed.');
    }
    if (this.currentTurnId) {
      throw new Error('A prompt is already running for this session.');
    }

    const turnId = newId();
    const startedAt = Date.now();
    this.currentTurnId = turnId;
    this.currentMessageId = null;
    this.currentReasoningId = null;
    this.cancelling = false;
    this.emitEvent({
      type: 'turn.started',
      sessionId: this.sessionId,
      at: startedAt,
      turnId,
    });
    this.setStatus('running');

    try {
      const response = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      });
      this.flushPendingStreams();
      const stopReason = typeof response?.stopReason === 'string' ? response.stopReason : null;
      this.emitEvent({
        type: 'turn.completed',
        sessionId: this.sessionId,
        at: Date.now(),
        turnId,
        stopReason,
      });
      this.resetTurnState();
      this.setStatus('idle');
      return { stopReason };
    } catch (error) {
      this.flushPendingStreams();
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = this.cancelling || /cancel/i.test(message);
      if (cancelled) {
        this.emitEvent({
          type: 'turn.cancelled',
          sessionId: this.sessionId,
          at: Date.now(),
          turnId,
          reason: message || 'Cancelled',
        });
        this.resetTurnState();
        this.setStatus('idle');
        return { stopReason: 'cancelled' };
      }

      this.emitEvent({
        type: 'turn.failed',
        sessionId: this.sessionId,
        at: Date.now(),
        turnId,
        error: message,
      });
      this.resetTurnState();
      this.setStatus('idle');
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (!this.currentTurnId) {
      return;
    }
    this.cancelling = true;
    this.setStatus('cancelling');
    await this.connection.cancel({ sessionId: this.sessionId });
  }

  /**
   * Switch the active mode for this session via ACP `session/set_mode`. Throws
   * if the connected agent does not implement the request.
   */
  async setMode(modeId: string): Promise<void> {
    if (this.status === 'disposed') {
      throw new Error('Session has already been disposed.');
    }
    if (typeof this.connection.setSessionMode !== 'function') {
      throw new Error('The ACP connection does not support session/set_mode.');
    }
    await this.connection.setSessionMode({ sessionId: this.sessionId, modeId });
  }

  /**
   * Switch the active model for this session via ACP `session/set_model`
   * (currently exposed by the SDK as `unstable_setSessionModel`). Throws if
   * the connected agent does not implement the request.
   */
  async setModel(modelId: string): Promise<void> {
    if (this.status === 'disposed') {
      throw new Error('Session has already been disposed.');
    }
    if (typeof this.connection.unstable_setSessionModel !== 'function') {
      throw new Error('The ACP connection does not support session/set_model.');
    }
    await this.connection.unstable_setSessionModel({ sessionId: this.sessionId, modelId });
  }

  async dispose(): Promise<void> {
    if (this.status === 'disposed') {
      return;
    }
    // Note: connection lifecycle is owned by AcpRuntime (one process per runtime,
    // many sessions per process). Disposing a session releases its slot in the
    // runtime's session router but does not close the underlying ACP connection.
    this.resetTurnState();
    this.setStatus('disposed');
    this.listeners.clear();
  }

  /** ES Explicit Resource Management: enables `await using session = await acp.newSession(...)`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  /** @internal Called by the runtime to deliver an incoming ACP `session/update`. */
  handleSessionUpdate(notification: SessionNotification): void {
    const turnId = this.currentTurnId || undefined;
    const events = normalizeAcpUpdate(notification, {
      sessionId: this.sessionId,
      turnId,
      messageId: this.ensureMessageId(),
      reasoningId: this.ensureReasoningId(),
    });

    for (const event of events) {
      this.emitRuntimeEvent(event);
    }
  }

  hydrateInitialState(initialEvents: RuntimeEvent[]): void {
    for (const event of initialEvents) {
      applyRuntimeEvent(this.transcript, event);
    }
  }

  private ensureMessageId(): string {
    if (!this.currentMessageId) {
      this.currentMessageId = `message:${this.currentTurnId || newId()}`;
    }
    return this.currentMessageId;
  }

  private ensureReasoningId(): string {
    if (!this.currentReasoningId) {
      this.currentReasoningId = `reasoning:${this.currentTurnId || newId()}`;
    }
    return this.currentReasoningId;
  }

  private flushPendingStreams(): void {
    const completions = flushOpenStreamCompletions(this.transcript, Date.now());
    for (const event of completions) {
      this.emitEvent(event);
    }
  }

  private emitRuntimeEvent(event: RuntimeEvent): void {
    applyRuntimeEvent(this.transcript, event);
    this.emitEvent(event);
  }

  private emitEvent(event: RuntimeSessionEvent): void {
    this.dispatch(event.type, event);
    this.dispatch('event', event);
  }

  private dispatch(type: string, event: RuntimeSessionEvent): void {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }

  private resetTurnState(): void {
    this.currentTurnId = null;
    this.currentMessageId = null;
    this.currentReasoningId = null;
    this.cancelling = false;
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) {
      return;
    }
    const previousStatus = this.status;
    this.status = status;
    this.emitEvent({
      type: 'status.changed',
      sessionId: this.sessionId,
      at: Date.now(),
      status,
      previousStatus,
    });
  }
}

export function createInitialSessionEvents(params: {
  sessionId: string;
  at?: number;
  configOptions?: SessionConfigUpdatedEvent['configOptions'];
  modes?: SessionModesUpdatedEvent['state'];
  models?: SessionModelsUpdatedEvent['state'];
}): RuntimeEvent[] {
  const at = Number.isFinite(params.at) ? Number(params.at) : Date.now();
  const events: RuntimeEvent[] = [];

  if (Array.isArray(params.configOptions) && params.configOptions.length > 0) {
    events.push({
      type: 'session.config.updated',
      sessionId: params.sessionId,
      at,
      configOptions: params.configOptions,
    });
  }
  if (params.modes) {
    events.push({
      type: 'session.modes.updated',
      sessionId: params.sessionId,
      at,
      state: params.modes,
    });
    if (params.modes.currentModeId) {
      events.push({
        type: 'session.mode.updated',
        sessionId: params.sessionId,
        at,
        currentModeId: params.modes.currentModeId,
      } satisfies SessionModeUpdatedEvent);
    }
  }
  if (params.models) {
    events.push({
      type: 'session.models.updated',
      sessionId: params.sessionId,
      at,
      state: params.models,
    });
    if (params.models.currentModelId) {
      events.push({
        type: 'session.model.updated',
        sessionId: params.sessionId,
        at,
        currentModelId: params.models.currentModelId,
      } satisfies SessionModelUpdatedEvent);
    }
  }

  return events;
}