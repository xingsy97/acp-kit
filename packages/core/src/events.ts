import type {
  AvailableCommand,
  SessionConfigOption,
  SessionModelState,
  SessionModeState,
  Usage,
} from '@agentclientprotocol/sdk';

export type RuntimeToolStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface RuntimeEventBase {
  type: string;
  sessionId: string;
  at: number;
  turnId?: string;
}

export interface MessageDeltaEvent extends RuntimeEventBase {
  type: 'message.delta';
  messageId: string;
  delta: string;
}

export interface MessageCompletedEvent extends RuntimeEventBase {
  type: 'message.completed';
  messageId: string;
  content: string;
}

export interface ReasoningDeltaEvent extends RuntimeEventBase {
  type: 'reasoning.delta';
  reasoningId: string;
  delta: string;
}

export interface ReasoningCompletedEvent extends RuntimeEventBase {
  type: 'reasoning.completed';
  reasoningId: string;
  content: string;
}

export interface ToolStartEvent extends RuntimeEventBase {
  type: 'tool.start';
  toolCallId: string;
  name: string;
  title?: string;
  kind?: string;
  status: RuntimeToolStatus;
  input?: unknown;
  locations?: unknown[];
  /** Raw `_meta` from the ACP update, forwarded verbatim (ACP spec vendor-extension slot). */
  meta?: Record<string, unknown>;
}

export interface ToolUpdateEvent extends RuntimeEventBase {
  type: 'tool.update';
  toolCallId: string;
  status: RuntimeToolStatus;
  title?: string;
  output?: unknown;
  /** Raw `_meta` from the ACP update, forwarded verbatim. */
  meta?: Record<string, unknown>;
}

export interface ToolEndEvent extends RuntimeEventBase {
  type: 'tool.end';
  toolCallId: string;
  status: Extract<RuntimeToolStatus, 'completed' | 'failed'>;
  title?: string;
  output?: unknown;
  /** Raw `_meta` from the ACP update, forwarded verbatim. */
  meta?: Record<string, unknown>;
}

export interface SessionErrorEvent extends RuntimeEventBase {
  type: 'session.error';
  message: string;
}

export interface SessionCommandsUpdatedEvent extends RuntimeEventBase {
  type: 'session.commands.updated';
  commands: AvailableCommand[];
}

export interface SessionConfigUpdatedEvent extends RuntimeEventBase {
  type: 'session.config.updated';
  configOptions: SessionConfigOption[];
}

export interface SessionModesUpdatedEvent extends RuntimeEventBase {
  type: 'session.modes.updated';
  state: SessionModeState;
}

export interface SessionModeUpdatedEvent extends RuntimeEventBase {
  type: 'session.mode.updated';
  currentModeId: string;
}

export interface SessionModelsUpdatedEvent extends RuntimeEventBase {
  type: 'session.models.updated';
  state: SessionModelState;
}

export interface SessionModelUpdatedEvent extends RuntimeEventBase {
  type: 'session.model.updated';
  currentModelId: string;
}

export interface RuntimeUsage {
  /** Current context tokens in use, reported by ACP `usage_update`. */
  used?: number;
  /** Total context window size, reported by ACP `usage_update`. */
  size?: number;
  cost?: number | null;
  inputTokens?: Usage['inputTokens'];
  outputTokens?: Usage['outputTokens'];
  totalTokens?: Usage['totalTokens'];
  cachedReadTokens?: Usage['cachedReadTokens'];
  cachedWriteTokens?: Usage['cachedWriteTokens'];
  thoughtTokens?: Usage['thoughtTokens'];
}

export interface SessionUsageUpdatedEvent extends RuntimeEventBase, RuntimeUsage {
  type: 'session.usage.updated';
}

export type RuntimeEvent =
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ReasoningDeltaEvent
  | ReasoningCompletedEvent
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolEndEvent
  | SessionCommandsUpdatedEvent
  | SessionConfigUpdatedEvent
  | SessionModesUpdatedEvent
  | SessionModeUpdatedEvent
  | SessionModelsUpdatedEvent
  | SessionModelUpdatedEvent
  | SessionUsageUpdatedEvent
  | SessionErrorEvent;
