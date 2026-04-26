import type { AgentProfile } from './agents.js';
import type { RuntimeEvent } from './events.js';
import type { PermissionDecision, RuntimePermissionRequest } from './host.js';
import { applyRuntimeEvent, cloneTranscriptState, createTranscriptState, type TranscriptState } from './session-data.js';
import type { RuntimeSessionEvent } from './session.js';
import { onRuntimeEvent, type RuntimeEventHandlers } from './runtime-event.js';

export interface RuntimeContext {
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface RuntimeObservationBase {
  type: string;
  at: number;
  runtimeId: string;
  agentId: string;
  context?: RuntimeContext;
}

export type RuntimeObservation =
  | (RuntimeObservationBase & { type: 'runtime.connect.started' })
  | (RuntimeObservationBase & { type: 'runtime.connect.completed'; durationMs: number })
  | (RuntimeObservationBase & { type: 'runtime.connect.failed'; durationMs: number; error: string })
  | (RuntimeObservationBase & { type: 'runtime.shutdown.started' })
  | (RuntimeObservationBase & { type: 'runtime.shutdown.completed'; durationMs: number })
  | (RuntimeObservationBase & { type: 'session.created' | 'session.loaded' | 'session.disposed'; sessionId: string; cwd?: string })
  | (RuntimeObservationBase & { type: 'session.status.changed'; sessionId: string; status: string; previousStatus: string | null })
  | (RuntimeObservationBase & { type: 'turn.started'; sessionId: string; turnId: string })
  | (RuntimeObservationBase & { type: 'turn.completed'; sessionId: string; turnId: string; stopReason: string | null })
  | (RuntimeObservationBase & { type: 'turn.failed' | 'turn.cancelled'; sessionId: string; turnId: string; error?: string; reason?: string })
  | (RuntimeObservationBase & { type: 'tool.started'; sessionId: string; turnId?: string; toolCallId: string; toolName: string; title?: string })
  | (RuntimeObservationBase & { type: 'tool.updated'; sessionId: string; turnId?: string; toolCallId: string; status: string })
  | (RuntimeObservationBase & { type: 'tool.completed'; sessionId: string; turnId?: string; toolCallId: string; status: string })
  | (RuntimeObservationBase & { type: 'permission.requested'; sessionId: string; toolCallId: string; toolName: string; title: string })
  | (RuntimeObservationBase & { type: 'permission.decided'; sessionId: string; toolCallId: string; toolName: string; decision: PermissionDecision })
  | (RuntimeObservationBase & { type: 'permission.failed'; sessionId: string; toolCallId: string; toolName: string; error: string })
  | (RuntimeObservationBase & { type: 'approval.queued'; sessionId: string; toolCallId: string; toolName: string; approvalId: string })
  | (RuntimeObservationBase & { type: 'approval.decided'; sessionId: string; toolCallId: string; toolName: string; approvalId: string; decision: PermissionDecision })
  | (RuntimeObservationBase & { type: 'session.error'; sessionId: string; turnId?: string; error: string })
  | (RuntimeObservationBase & { type: 'error'; sessionId?: string; turnId?: string; error: string });

export type RuntimeObservationSink = (observation: RuntimeObservation) => void | Promise<void>;

export interface RuntimeObservabilityOptions {
  sink?: RuntimeObservationSink;
}

export interface RuntimeEventStoreQuery {
  runtimeId?: string;
  sessionId?: string;
  kind?: RuntimeStoreEntry['kind'];
}

export type RuntimeStoreEntry =
  | {
      kind: 'observation';
      at: number;
      runtimeId: string;
      agentId: string;
      context?: RuntimeContext;
      observation: RuntimeObservation;
    }
  | {
      kind: 'session.event';
      at: number;
      runtimeId: string;
      agentId: string;
      context?: RuntimeContext;
      sessionId: string;
      event: RuntimeSessionEvent;
    }
  | {
      kind: 'transcript.snapshot';
      at: number;
      runtimeId: string;
      agentId: string;
      context?: RuntimeContext;
      sessionId: string;
      snapshot: TranscriptState;
    };

export interface RuntimeEventStore {
  append(entry: RuntimeStoreEntry): void | Promise<void>;
  load?(query?: RuntimeEventStoreQuery): Promise<RuntimeStoreEntry[]>;
}

export interface RuntimeApprovalRequest extends RuntimePermissionRequest {
  approvalId: string;
  runtimeId: string;
  agentId: string;
  context?: RuntimeContext;
  requestedAt: number;
}

export interface RuntimeApprovalTicket {
  approvalId: string;
  [key: string]: unknown;
}

export interface RuntimeApprovalQueue {
  request(request: RuntimeApprovalRequest): RuntimeApprovalTicket | string | void | Promise<RuntimeApprovalTicket | string | void>;
  waitForDecision(ticket: RuntimeApprovalTicket): PermissionDecision | Promise<PermissionDecision>;
}

export interface RuntimeReplay {
  events: RuntimeSessionEvent[];
  transcript: TranscriptState;
  replay<R = void>(handlers: RuntimeEventHandlers<RuntimeSessionEvent, R>): Array<R | undefined>;
}

export function replayRuntimeEvents<R = void>(
  events: Iterable<RuntimeSessionEvent>,
  handlers: RuntimeEventHandlers<RuntimeSessionEvent, R>,
): Array<R | undefined> {
  const results: Array<R | undefined> = [];
  for (const event of events) {
    results.push(onRuntimeEvent(event, handlers));
  }
  return results;
}

export function buildTranscriptFromRuntimeEvents(events: Iterable<RuntimeSessionEvent>): TranscriptState {
  const transcript = createTranscriptState();
  for (const event of events) {
    if (isTranscriptEvent(event)) {
      applyRuntimeEvent(transcript, event);
    }
  }
  return transcript;
}

export function createRuntimeReplay(events: Iterable<RuntimeSessionEvent>): RuntimeReplay {
  const materialized = [...events];
  const transcript = buildTranscriptFromRuntimeEvents(materialized);
  return {
    events: materialized,
    transcript: cloneTranscriptState(transcript),
    replay: (handlers) => replayRuntimeEvents(materialized, handlers),
  };
}

export async function loadRuntimeReplay(
  store: RuntimeEventStore,
  query: RuntimeEventStoreQuery,
): Promise<RuntimeReplay> {
  if (!store.load) {
    throw new Error('RuntimeEventStore does not implement load().');
  }
  const entries = await store.load({ ...query, kind: 'session.event' });
  return createRuntimeReplay(
    entries
      .filter((entry): entry is Extract<RuntimeStoreEntry, { kind: 'session.event' }> => entry.kind === 'session.event')
      .map((entry) => entry.event),
  );
}

export function sessionEventToObservation(params: {
  event: RuntimeSessionEvent;
  runtimeId: string;
  agent: AgentProfile;
  context?: RuntimeContext;
}): RuntimeObservation | null {
  const base = {
    at: params.event.at,
    runtimeId: params.runtimeId,
    agentId: params.agent.id,
    context: params.context,
  };

  switch (params.event.type) {
    case 'status.changed':
      return {
        ...base,
        type: 'session.status.changed',
        sessionId: params.event.sessionId,
        status: params.event.status,
        previousStatus: params.event.previousStatus,
      };
    case 'turn.started':
      return { ...base, type: 'turn.started', sessionId: params.event.sessionId, turnId: params.event.turnId };
    case 'turn.completed':
      return {
        ...base,
        type: 'turn.completed',
        sessionId: params.event.sessionId,
        turnId: params.event.turnId,
        stopReason: params.event.stopReason,
      };
    case 'turn.failed':
      return {
        ...base,
        type: 'turn.failed',
        sessionId: params.event.sessionId,
        turnId: params.event.turnId,
        error: params.event.error,
      };
    case 'turn.cancelled':
      return {
        ...base,
        type: 'turn.cancelled',
        sessionId: params.event.sessionId,
        turnId: params.event.turnId,
        reason: params.event.reason,
      };
    case 'tool.start':
      return {
        ...base,
        type: 'tool.started',
        sessionId: params.event.sessionId,
        turnId: params.event.turnId,
        toolCallId: params.event.toolCallId,
        toolName: params.event.name,
        title: params.event.title,
      };
    case 'tool.update':
      return {
        ...base,
        type: 'tool.updated',
        sessionId: params.event.sessionId,
        turnId: params.event.turnId,
        toolCallId: params.event.toolCallId,
        status: params.event.status,
      };
    case 'tool.end':
      return {
        ...base,
        type: 'tool.completed',
        sessionId: params.event.sessionId,
        turnId: params.event.turnId,
        toolCallId: params.event.toolCallId,
        status: params.event.status,
      };
    case 'session.error':
      return {
        ...base,
        type: 'session.error',
        sessionId: params.event.sessionId,
        turnId: params.event.turnId,
        error: params.event.message,
      };
    default:
      return null;
  }
}

function isTranscriptEvent(event: RuntimeSessionEvent): event is RuntimeEvent {
  return event.type === 'message.delta'
    || event.type === 'message.completed'
    || event.type === 'reasoning.delta'
    || event.type === 'reasoning.completed'
    || event.type === 'tool.start'
    || event.type === 'tool.update'
    || event.type === 'tool.end'
    || event.type === 'session.commands.updated'
    || event.type === 'session.config.updated'
    || event.type === 'session.modes.updated'
    || event.type === 'session.mode.updated'
    || event.type === 'session.models.updated'
    || event.type === 'session.model.updated'
    || event.type === 'session.usage.updated'
    || event.type === 'session.error';
}
