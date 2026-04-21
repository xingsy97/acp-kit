import type {
  SessionConfigOption,
  SessionModelState,
  SessionModeState,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import type { RuntimeEvent, RuntimeToolStatus } from './events.js';

export interface NormalizeUpdateContext {
  sessionId: string;
  at?: number;
  turnId?: string;
  messageId?: string;
  reasoningId?: string;
}

type RawUpdate = Record<string, unknown> & {
  sessionUpdate?: string;
};

function resolveAt(context: NormalizeUpdateContext): number {
  return Number.isFinite(context.at) ? Number(context.at) : Date.now();
}

function readTextPayload(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  return typeof (value as { text?: unknown }).text === 'string'
    ? (value as { text: string }).text
    : '';
}

function normalizeToolStatus(status: unknown): RuntimeToolStatus {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'completed' || normalized === 'success') return 'completed';
  if (normalized === 'error' || normalized === 'failed') return 'failed';
  if (normalized === 'running' || normalized === 'in_progress' || normalized === 'in-progress') return 'running';
  return 'pending';
}

function readToolName(update: RawUpdate): string {
  if (typeof update.toolName === 'string' && update.toolName) return update.toolName;
  if (typeof update.title === 'string' && update.title) return update.title;
  const meta = update._meta;
  if (meta && typeof meta === 'object') {
    const claudeCode = (meta as { claudeCode?: { toolName?: unknown } }).claudeCode;
    if (claudeCode && typeof claudeCode.toolName === 'string' && claudeCode.toolName) {
      return claudeCode.toolName;
    }
  }
  return 'tool';
}

function readToolInput(update: RawUpdate): unknown {
  if ('input' in update) return update.input;
  const meta = update._meta;
  if (meta && typeof meta === 'object') {
    const claudeCode = (meta as { claudeCode?: { input?: unknown } }).claudeCode;
    if (claudeCode && 'input' in claudeCode) return claudeCode.input;
  }
  return undefined;
}

function readToolOutput(update: RawUpdate): unknown {
  if ('toolResponse' in update) return update.toolResponse;
  if ('rawOutput' in update) return update.rawOutput;
  const meta = update._meta;
  if (meta && typeof meta === 'object') {
    const claudeCode = (meta as { claudeCode?: { toolResponse?: unknown } }).claudeCode;
    if (claudeCode && 'toolResponse' in claudeCode) return claudeCode.toolResponse;
  }
  return undefined;
}

function readConfigOptions(update: RawUpdate): SessionConfigOption[] | null {
  if (Array.isArray(update.configOptions)) {
    return update.configOptions as SessionConfigOption[];
  }
  if (update.configOption && typeof update.configOption === 'object') {
    return [update.configOption as SessionConfigOption];
  }
  return null;
}

function readModeState(update: RawUpdate): SessionModeState | null {
  if (Array.isArray(update.availableModes)) {
    return update as unknown as SessionModeState;
  }
  if (update.modes && typeof update.modes === 'object' && Array.isArray((update.modes as { availableModes?: unknown[] }).availableModes)) {
    return update.modes as SessionModeState;
  }
  return null;
}

function readModelState(update: RawUpdate): SessionModelState | null {
  if (Array.isArray(update.availableModels)) {
    return update as unknown as SessionModelState;
  }
  if (update.models && typeof update.models === 'object' && Array.isArray((update.models as { availableModels?: unknown[] }).availableModels)) {
    return update.models as SessionModelState;
  }
  return null;
}

export function normalizeAcpUpdate(
  notification: SessionNotification,
  context: NormalizeUpdateContext,
): RuntimeEvent[] {
  const update = (notification.update ?? {}) as RawUpdate;
  const updateType = String(update.sessionUpdate || '').trim();
  const at = resolveAt(context);
  const sessionId = context.sessionId;
  const turnId = context.turnId;

  switch (updateType) {
    case 'agent_message_chunk': {
      const delta = readTextPayload(update.content);
      if (!delta) return [];
      return [{
        type: 'message.delta',
        sessionId,
        at,
        turnId,
        messageId: context.messageId || turnId || 'message',
        delta,
      }];
    }
    case 'agent_thought_chunk': {
      const delta = readTextPayload(update.content);
      if (!delta) return [];
      return [{
        type: 'reasoning.delta',
        sessionId,
        at,
        turnId,
        reasoningId: context.reasoningId || turnId || 'reasoning',
        delta,
      }];
    }
    case 'tool_call': {
      if (typeof update.toolCallId !== 'string' || !update.toolCallId) {
        return [];
      }
      return [{
        type: 'tool.start',
        sessionId,
        at,
        turnId,
        toolCallId: update.toolCallId,
        name: readToolName(update),
        title: typeof update.title === 'string' ? update.title : undefined,
        kind: typeof update.kind === 'string' ? update.kind : undefined,
        status: normalizeToolStatus(update.status),
        input: readToolInput(update),
        locations: Array.isArray(update.locations) ? update.locations : undefined,
      }];
    }
    case 'tool_call_update': {
      if (typeof update.toolCallId !== 'string' || !update.toolCallId) {
        return [];
      }
      const status = normalizeToolStatus(update.status);
      if (status === 'completed' || status === 'failed') {
        return [{
          type: 'tool.end',
          sessionId,
          at,
          turnId,
          toolCallId: update.toolCallId,
          status,
          title: typeof update.title === 'string' ? update.title : undefined,
          output: readToolOutput(update),
        }];
      }
      return [{
        type: 'tool.update',
        sessionId,
        at,
        turnId,
        toolCallId: update.toolCallId,
        status,
        title: typeof update.title === 'string' ? update.title : undefined,
        output: readToolOutput(update),
      }];
    }
    case 'available_commands_update': {
      const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      return [{
        type: 'session.commands.updated',
        sessionId,
        at,
        turnId,
        commands: commands as never,
      }];
    }
    case 'current_mode_update': {
      if (typeof update.currentModeId !== 'string' || !update.currentModeId) {
        return [];
      }
      return [{
        type: 'session.mode.updated',
        sessionId,
        at,
        turnId,
        currentModeId: update.currentModeId,
      }];
    }
    case 'usage_update': {
      return [{
        type: 'session.usage.updated',
        sessionId,
        at,
        turnId,
        used: Number.isFinite(Number(update.used)) ? Number(update.used) : undefined,
        size: Number.isFinite(Number(update.size)) ? Number(update.size) : undefined,
        cost: Number.isFinite(Number(update.cost)) ? Number(update.cost) : null,
      }];
    }
    case 'config_option_update':
    case 'config_options_update': {
      const configOptions = readConfigOptions(update);
      if (!configOptions) return [];
      return [{
        type: 'session.config.updated',
        sessionId,
        at,
        turnId,
        configOptions,
      }];
    }
    case 'modes_update': {
      const state = readModeState(update);
      if (!state) return [];
      return [{
        type: 'session.modes.updated',
        sessionId,
        at,
        turnId,
        state,
      }];
    }
    case 'models_update': {
      const state = readModelState(update);
      if (!state) return [];
      return [{
        type: 'session.models.updated',
        sessionId,
        at,
        turnId,
        state,
      }];
    }
    default:
      return [];
  }
}
