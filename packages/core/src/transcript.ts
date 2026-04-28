import type {
  AvailableCommand,
  SessionConfigOption,
  SessionModelState,
  SessionModeState,
  Usage,
} from '@agentclientprotocol/sdk';

import type { RuntimeEvent, RuntimeToolStatus } from './events.js';

export interface TranscriptBlock {
  id: string;
  kind: 'message' | 'reasoning';
  sessionId: string;
  turnId?: string;
  content: string;
  completed: boolean;
}

export interface TranscriptToolRecord {
  toolCallId: string;
  sessionId: string;
  turnId?: string;
  name: string;
  title?: string;
  kind?: string;
  status: RuntimeToolStatus;
  input?: unknown;
  output?: unknown;
  locations?: unknown[];
}

export interface TranscriptSessionMetadata {
  commands: AvailableCommand[];
  configOptions: SessionConfigOption[];
  modes?: SessionModeState;
  currentModeId?: string;
  models?: SessionModelState;
  currentModelId?: string;
  usage: {
    used?: number;
    size?: number;
    cost?: number | null;
    inputTokens?: Usage['inputTokens'];
    outputTokens?: Usage['outputTokens'];
    totalTokens?: Usage['totalTokens'];
    cachedReadTokens?: Usage['cachedReadTokens'];
    cachedWriteTokens?: Usage['cachedWriteTokens'];
    thoughtTokens?: Usage['thoughtTokens'];
  };
}

export interface TranscriptState {
  blocks: TranscriptBlock[];
  tools: Record<string, TranscriptToolRecord>;
  session: TranscriptSessionMetadata;
}

export function createTranscriptState(): TranscriptState {
  return {
    blocks: [],
    tools: {},
    session: {
      commands: [],
      configOptions: [],
      usage: {},
    },
  };
}

export function cloneTranscriptState(state: TranscriptState): TranscriptState {
  return {
    blocks: state.blocks.map((block) => ({ ...block })),
    tools: Object.fromEntries(
      Object.entries(state.tools).map(([key, value]) => [key, { ...value }]),
    ),
    session: {
      commands: [...state.session.commands],
      configOptions: [...state.session.configOptions],
      modes: state.session.modes
        ? {
          ...state.session.modes,
          availableModes: [...state.session.modes.availableModes],
        }
        : undefined,
      currentModeId: state.session.currentModeId,
      models: state.session.models
        ? {
          ...state.session.models,
          availableModels: [...state.session.models.availableModels],
        }
        : undefined,
      currentModelId: state.session.currentModelId,
      usage: { ...state.session.usage },
    },
  };
}

function upsertBlock(
  state: TranscriptState,
  id: string,
  kind: TranscriptBlock['kind'],
  sessionId: string,
  turnId?: string,
): TranscriptBlock {
  let block = state.blocks.find((entry) => entry.id === id && entry.kind === kind);
  if (block) {
    return block;
  }
  block = {
    id,
    kind,
    sessionId,
    turnId,
    content: '',
    completed: false,
  };
  state.blocks.push(block);
  return block;
}

export function applyRuntimeEvent(state: TranscriptState, event: RuntimeEvent): TranscriptState {
  switch (event.type) {
    case 'message.delta': {
      const block = upsertBlock(state, event.messageId, 'message', event.sessionId, event.turnId);
      block.content += event.delta;
      break;
    }
    case 'message.completed': {
      const block = upsertBlock(state, event.messageId, 'message', event.sessionId, event.turnId);
      block.content = event.content;
      block.completed = true;
      break;
    }
    case 'reasoning.delta': {
      const block = upsertBlock(state, event.reasoningId, 'reasoning', event.sessionId, event.turnId);
      block.content += event.delta;
      break;
    }
    case 'reasoning.completed': {
      const block = upsertBlock(state, event.reasoningId, 'reasoning', event.sessionId, event.turnId);
      block.content = event.content;
      block.completed = true;
      break;
    }
    case 'tool.start': {
      state.tools[event.toolCallId] = {
        toolCallId: event.toolCallId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        name: event.name,
        title: event.title,
        kind: event.kind,
        status: event.status,
        input: event.input,
        locations: event.locations,
      };
      break;
    }
    case 'tool.update':
    case 'tool.end': {
      const current = state.tools[event.toolCallId] || {
        toolCallId: event.toolCallId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        name: 'tool',
        status: 'pending' as RuntimeToolStatus,
      };
      state.tools[event.toolCallId] = {
        ...current,
        title: event.title ?? current.title,
        status: event.status,
        output: event.output ?? current.output,
      };
      break;
    }
    case 'session.commands.updated': {
      state.session.commands = [...event.commands];
      break;
    }
    case 'session.config.updated': {
      state.session.configOptions = [...event.configOptions];
      break;
    }
    case 'session.modes.updated': {
      state.session.modes = event.state;
      state.session.currentModeId = event.state.currentModeId || state.session.currentModeId;
      break;
    }
    case 'session.mode.updated': {
      state.session.currentModeId = event.currentModeId;
      if (state.session.modes) {
        state.session.modes = {
          ...state.session.modes,
          currentModeId: event.currentModeId,
        };
      }
      break;
    }
    case 'session.models.updated': {
      state.session.models = event.state;
      state.session.currentModelId = event.state.currentModelId || state.session.currentModelId;
      break;
    }
    case 'session.model.updated': {
      state.session.currentModelId = event.currentModelId;
      if (state.session.models) {
        state.session.models = {
          ...state.session.models,
          currentModelId: event.currentModelId,
        };
      }
      break;
    }
    case 'session.usage.updated': {
      state.session.usage = {
        ...state.session.usage,
        used: event.used ?? state.session.usage.used,
        size: event.size ?? state.session.usage.size,
        cost: event.cost ?? state.session.usage.cost,
        inputTokens: event.inputTokens ?? state.session.usage.inputTokens,
        outputTokens: event.outputTokens ?? state.session.usage.outputTokens,
        totalTokens: event.totalTokens ?? state.session.usage.totalTokens,
        cachedReadTokens: event.cachedReadTokens ?? state.session.usage.cachedReadTokens,
        cachedWriteTokens: event.cachedWriteTokens ?? state.session.usage.cachedWriteTokens,
        thoughtTokens: event.thoughtTokens ?? state.session.usage.thoughtTokens,
      };
      break;
    }
  }

  return state;
}

export function applyRuntimeEvents(state: TranscriptState, events: RuntimeEvent[]): TranscriptState {
  for (const event of events) {
    applyRuntimeEvent(state, event);
  }
  return state;
}

export function flushOpenStreamCompletions(state: TranscriptState, at: number = Date.now()): RuntimeEvent[] {
  const completedEvents: RuntimeEvent[] = [];

  for (const block of state.blocks) {
    if (block.completed) {
      continue;
    }

    block.completed = true;
    if (block.kind === 'message') {
      completedEvents.push({
        type: 'message.completed',
        sessionId: block.sessionId,
        at,
        turnId: block.turnId,
        messageId: block.id,
        content: block.content,
      });
      continue;
    }

    completedEvents.push({
      type: 'reasoning.completed',
      sessionId: block.sessionId,
      at,
      turnId: block.turnId,
      reasoningId: block.id,
      content: block.content,
    });
  }

  return completedEvents;
}
