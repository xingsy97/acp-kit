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

/**
 * Returned by `session.prompt(text)`. It is both:
 *   - awaitable: `await session.prompt("...")` resolves to `PromptResult` when the turn ends.
 *   - async-iterable: `for await (const ev of session.prompt("..."))` yields raw
 *     ACP `SessionNotification`s scoped to this turn (use `ev.sessionUpdate` discriminator).
 *
 * Iteration completes naturally when the turn finishes; if the turn fails, iteration throws.
 */
export interface PromptHandle extends Promise<PromptResult>, AsyncIterable<SessionNotification> {}

type Listener = (event: RuntimeSessionEvent) => void;
type RawListener = (notification: SessionNotification) => void;

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
  private readonly rawListeners = new Set<RawListener>();
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

  on(type: RuntimeSessionEvent['type'] | 'event', listener: Listener): () => void {
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

  /**
   * Subscribe to raw ACP `session/update` notifications for this session.
   * Returns an unsubscribe function. Use `events()` for an async-iterable form.
   */
  onRawNotification(listener: RawListener): () => void {
    this.rawListeners.add(listener);
    return () => {
      this.rawListeners.delete(listener);
    };
  }

  /**
   * Async iterable of raw ACP `session/update` notifications until the session is disposed.
   */
  events(): AsyncIterableIterator<SessionNotification> {
    return createNotificationStream(this, () => this.status === 'disposed');
  }

  getSnapshot(): TranscriptState {
    return cloneTranscriptState(this.transcript);
  }

  prompt(text: string): PromptHandle {
    return createPromptHandle(this, text);
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
    this.rawListeners.clear();
  }

  /** ES Explicit Resource Management: enables `await using session = await acp.newSession(...)`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  handleSessionUpdate(notification: SessionNotification): void {
    for (const listener of this.rawListeners) {
      try {
        listener(notification);
      } catch {
        /* raw listener errors must not break normalization */
      }
    }
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

  /** @internal Used by `prompt()` PromptHandle to drive the underlying connection. */
  async _runPromptTurn(text: string): Promise<PromptResult> {
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

/* ------------------------------------------------------------------------- */
/* PromptHandle and event-stream helpers                                     */
/* ------------------------------------------------------------------------- */

function createPromptHandle(session: RuntimeSession, text: string): PromptHandle {
  let promptStarted = false;
  const queue: SessionNotification[] = [];
  const waiters: Array<(value: IteratorResult<SessionNotification>) => void> = [];
  let done = false;
  let error: unknown = null;

  const unsubscribe = session.onRawNotification((notification) => {
    if (done) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value: notification, done: false });
    } else {
      queue.push(notification);
    }
  });

  const startPrompt = (): Promise<PromptResult> => {
    if (!promptStarted) {
      promptStarted = true;
    }
    return session._runPromptTurn(text);
  };

  const promise: Promise<PromptResult> = startPrompt().then(
    (result) => {
      done = true;
      unsubscribe();
      while (waiters.length) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined as unknown as SessionNotification, done: true });
      }
      return result;
    },
    (err) => {
      done = true;
      error = err;
      unsubscribe();
      while (waiters.length) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined as unknown as SessionNotification, done: true });
      }
      throw err;
    },
  );

  const iterator: AsyncIterator<SessionNotification> = {
    next() {
      if (queue.length > 0) {
        const value = queue.shift() as SessionNotification;
        return Promise.resolve({ value, done: false });
      }
      if (done) {
        if (error) {
          return Promise.reject(error);
        }
        return Promise.resolve({ value: undefined as unknown as SessionNotification, done: true });
      }
      return new Promise<IteratorResult<SessionNotification>>((resolve) => {
        waiters.push(resolve);
      });
    },
    return() {
      done = true;
      unsubscribe();
      while (waiters.length) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined as unknown as SessionNotification, done: true });
      }
      return Promise.resolve({ value: undefined as unknown as SessionNotification, done: true });
    },
  };

  const handle = promise as PromptHandle;
  (handle as { [Symbol.asyncIterator]?: () => AsyncIterator<SessionNotification> })[
    Symbol.asyncIterator
  ] = () => iterator;
  return handle;
}

function createNotificationStream(
  session: RuntimeSession,
  isClosed: () => boolean,
): AsyncIterableIterator<SessionNotification> {
  const queue: SessionNotification[] = [];
  const waiters: Array<(value: IteratorResult<SessionNotification>) => void> = [];
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    while (waiters.length) {
      const waiter = waiters.shift();
      waiter?.({ value: undefined as unknown as SessionNotification, done: true });
    }
  };

  const unsubscribe = session.onRawNotification((notification) => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value: notification, done: false });
    } else {
      queue.push(notification);
    }
  });

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift() as SessionNotification, done: false });
      }
      if (closed || isClosed()) {
        close();
        return Promise.resolve({ value: undefined as unknown as SessionNotification, done: true });
      }
      return new Promise<IteratorResult<SessionNotification>>((resolve) => {
        waiters.push(resolve);
      });
    },
    return() {
      close();
      return Promise.resolve({ value: undefined as unknown as SessionNotification, done: true });
    },
  };
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
