import type { RuntimeSession, RuntimeSessionEvent, PromptResult } from './session.js';
import type { RuntimeUsage } from './events.js';

export type CollectedTurnStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface CollectedToolRun {
  id: string;
  tag: string;
  name?: string;
  title?: string;
  status: 'running' | 'completed' | 'failed';
  inputChars: number;
  outputChars: number;
}

export interface CollectedTurnResult {
  text: string;
  tools: CollectedToolRun[];
  status: CollectedTurnStatus;
  stopReason: string | null;
  error: string | null;
  promptResult: PromptResult | null;
  usage: RuntimeUsage | null;
  events?: RuntimeSessionEvent[];
}

export interface CollectTurnResultOptions {
  includeEvents?: boolean;
  onEvent?: (event: RuntimeSessionEvent, snapshot: CollectedTurnResult) => void;
  onUpdate?: (snapshot: CollectedTurnResult) => void;
}

type TurnResultSession = Pick<RuntimeSession, 'on' | 'prompt'>;

export async function collectTurnResult(
  session: TurnResultSession,
  prompt: string,
  options: CollectTurnResultOptions = {},
): Promise<CollectedTurnResult> {
  const tools = new Map<string, CollectedToolRun>();
  const events: RuntimeSessionEvent[] = [];
  const state: CollectedTurnResult = {
    text: '',
    tools: [],
    status: 'running',
    stopReason: null,
    error: null,
    promptResult: null,
    usage: null,
    events: options.includeEvents ? events : undefined,
  };

  const snapshot = () => ({
    ...state,
    tools: state.tools.map((tool) => ({ ...tool })),
    events: options.includeEvents ? [...events] : undefined,
  });

  const notify = (event: RuntimeSessionEvent) => {
    const current = snapshot();
    options.onEvent?.(event, current);
    options.onUpdate?.(current);
  };

  const ensureTool = (id: string, inputChars = 0): CollectedToolRun => {
    let tool = tools.get(id);
    if (!tool) {
      tool = { id, tag: `#${tools.size + 1}`, status: 'running', inputChars, outputChars: 0 };
      tools.set(id, tool);
      state.tools = [...tools.values()];
    }
    return tool;
  };

  const unsubscribe = session.on({
    messageDelta: (event) => {
      if (options.includeEvents) events.push(event);
      state.text += event.delta;
      notify(event);
    },
    messageCompleted: (event) => {
      if (options.includeEvents) events.push(event);
      if (!state.text) state.text = event.content;
      notify(event);
    },
    toolStart: (event) => {
      if (options.includeEvents) events.push(event);
      const tool = ensureTool(event.toolCallId, countChars(event.input));
      tool.name = event.name;
      tool.title = event.title;
      tool.status = 'running';
      state.tools = [...tools.values()];
      notify(event);
    },
    toolEnd: (event) => {
      if (options.includeEvents) events.push(event);
      const tool = ensureTool(event.toolCallId);
      tool.title = event.title ?? tool.title;
      tool.status = event.status;
      tool.outputChars = countChars(event.output);
      state.tools = [...tools.values()];
      notify(event);
    },
    sessionUsageUpdated: (event) => {
      if (options.includeEvents) events.push(event);
      if (hasUsage(event)) {
        state.usage = mergeUsage(state.usage, event);
      }
      notify(event);
    },
    turnCompleted: (event) => {
      if (options.includeEvents) events.push(event);
      state.status = 'completed';
      state.stopReason = event.stopReason;
      notify(event);
    },
    turnFailed: (event) => {
      if (options.includeEvents) events.push(event);
      state.status = 'failed';
      state.error = event.error;
      notify(event);
    },
    turnCancelled: (event) => {
      if (options.includeEvents) events.push(event);
      state.status = 'cancelled';
      state.error = event.reason;
      notify(event);
    },
  });

  try {
    state.promptResult = await session.prompt(prompt);
    state.usage = state.promptResult.usage
      ? mergeUsage(state.usage, state.promptResult.usage)
      : state.usage;
    return snapshot();
  } finally {
    unsubscribe();
  }
}

function countChars(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((count, item) => count + countChars(item), 0);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text.length;
    if (typeof record.content === 'string') return record.content.length;
    if (Array.isArray(record.content)) return countChars(record.content);
    if (typeof record.diff === 'string') return record.diff.length;
    return Object.values(record).reduce<number>((count, item) => count + countChars(item), 0);
  }
  return 0;
}

function mergeUsage(previous: RuntimeUsage | null | undefined, next: RuntimeUsage): RuntimeUsage {
  const usage: RuntimeUsage = { ...(previous || {}) };
  for (const key of [
    'used',
    'size',
    'cost',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cachedReadTokens',
    'cachedWriteTokens',
    'thoughtTokens',
  ] as const) {
    const value = next[key];
    if (typeof value === 'number' ? Number.isFinite(value) : value != null) {
      usage[key] = value as never;
    }
  }
  if (usage.totalTokens == null && (usage.inputTokens != null || usage.outputTokens != null)) {
    usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  return usage;
}

function hasUsage(event: {
  used?: unknown;
  size?: unknown;
  cost?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  cachedReadTokens?: unknown;
  cachedWriteTokens?: unknown;
  thoughtTokens?: unknown;
}): boolean {
  return [
    event.used,
    event.size,
    event.cost,
    event.inputTokens,
    event.outputTokens,
    event.totalTokens,
    event.cachedReadTokens,
    event.cachedWriteTokens,
    event.thoughtTokens,
  ].some((value) => typeof value === 'number' && Number.isFinite(value));
}
