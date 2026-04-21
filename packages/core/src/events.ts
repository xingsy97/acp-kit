import type {
  AvailableCommand,
  SessionConfigOption,
  SessionModelState,
  SessionModeState,
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
}

export interface ToolUpdateEvent extends RuntimeEventBase {
  type: 'tool.update';
  toolCallId: string;
  status: RuntimeToolStatus;
  title?: string;
  output?: unknown;
}

export interface ToolEndEvent extends RuntimeEventBase {
  type: 'tool.end';
  toolCallId: string;
  status: Extract<RuntimeToolStatus, 'completed' | 'failed'>;
  title?: string;
  output?: unknown;
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

export interface SessionUsageUpdatedEvent extends RuntimeEventBase {
  type: 'session.usage.updated';
  used?: number;
  size?: number;
  cost?: number | null;
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
  | SessionUsageUpdatedEvent;
