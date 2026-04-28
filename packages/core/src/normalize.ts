import type {
  SessionConfigOption,
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
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(readTextPayload).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'delta', 'thinking', 'reasoning']) {
    if (typeof record[key] === 'string' || Array.isArray(record[key])) return readTextPayload(record[key]);
  }
  return '';
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

/** Forward the raw `_meta` object from the ACP update verbatim, if present. */
function readMeta(update: RawUpdate): Record<string, unknown> | undefined {
  const meta = update._meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    return meta as Record<string, unknown>;
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

function readFiniteNumber(update: RawUpdate, key: string, ...fallbackKeys: string[]): number | undefined {
  const sourceKey = [key, ...fallbackKeys].find((candidate) => candidate in update);
  const raw = sourceKey ? update[sourceKey] : undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
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
    case 'agent_thought_chunk':
    case 'agent_reasoning_chunk':
    case 'reasoning_chunk':
    case 'thinking_chunk': {
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
    case 'agent_thought_completed':
    case 'agent_reasoning_completed':
    case 'reasoning_completed':
    case 'thinking_completed': {
      const content = readTextPayload(update.content);
      return [{
        type: 'reasoning.completed',
        sessionId,
        at,
        turnId,
        reasoningId: context.reasoningId || turnId || 'reasoning',
        content,
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
        meta: readMeta(update),
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
          meta: readMeta(update),
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
        meta: readMeta(update),
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
        used: readFiniteNumber(update, 'used', 'currentTokens', 'current_tokens'),
        size: readFiniteNumber(update, 'size', 'tokenLimit', 'token_limit'),
        cost: Number.isFinite(Number(update.cost)) ? Number(update.cost) : null,
        inputTokens: readFiniteNumber(update, 'inputTokens', 'input_tokens'),
        outputTokens: readFiniteNumber(update, 'outputTokens', 'output_tokens'),
        totalTokens: readFiniteNumber(update, 'totalTokens', 'total_tokens'),
        cachedReadTokens: readFiniteNumber(update, 'cachedReadTokens', 'cached_read_tokens'),
        cachedWriteTokens: readFiniteNumber(update, 'cachedWriteTokens', 'cached_write_tokens'),
        thoughtTokens: readFiniteNumber(update, 'thoughtTokens', 'thought_tokens'),
      }];
    }
    case 'config_option_update': {
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
    case 'session_error': {
      const message = typeof update.message === 'string' && update.message
        ? update.message
        : 'Session error';
      return [{
        type: 'session.error',
        sessionId,
        at,
        turnId,
        message,
      }];
    }
    default:
      return [];
  }
}
