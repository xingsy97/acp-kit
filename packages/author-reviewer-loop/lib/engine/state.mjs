export const PaneStatus = Object.freeze({
  Pending: 'pending',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
});

export const Phase = Object.freeze({
  Idle: 'idle',
  Launching: 'launching',
  Running: 'running',
  Done: 'done',
  Error: 'error',
});

const TRACE_ENTRY_LIMIT = 1000;
const TRACE_TOTAL_BYTES = 1_000_000;
const TRACE_ENTRY_BYTES = 64_000;

function emptyUsage() {
  return {
    used: 0,
    size: 0,
    cost: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    thoughtTokens: 0,
  };
}

function emptyPane() {
  return {
    status: PaneStatus.Pending,
    lines: [],
    current: '',
    flow: [],
    tools: [],
    usage: null,
    turnUsage: null,
    stopReason: null,
    error: null,
    chars: 0,
  };
}

function emptyRound() {
  return { AUTHOR: emptyPane(), REVIEWER: emptyPane() };
}

export function initialState() {
  return {
    phase: Phase.Idle,
    statuses: { AUTHOR: 'pending', REVIEWER: 'pending' },
    rounds: new Map(),
    order: [],
    trace: [],
    latest: null,
    usage: { AUTHOR: emptyUsage(), REVIEWER: emptyUsage() },
    result: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

function addUsage(left, right) {
  const next = { ...emptyUsage(), ...(left || {}) };
  if (!right) return next;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens']) {
    const value = right[key];
    if (Number.isFinite(value)) next[key] += value;
  }
  for (const key of ['used', 'size', 'cost']) {
    const value = right[key];
    if (Number.isFinite(value) || value === null) next[key] = value;
  }
  return next;
}

function subtractUsage(left, right) {
  const next = { ...emptyUsage(), ...(left || {}) };
  if (!right) return next;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens']) {
    const value = right[key];
    if (Number.isFinite(value)) next[key] = Math.max(0, next[key] - value);
  }
  return next;
}

function ensureRound(state, round) {
  if (state.rounds.has(round)) return state;
  const rounds = new Map(state.rounds);
  rounds.set(round, emptyRound());
  const order = [...state.order];
  if (!order.includes(round)) {
    order.push(round);
    order.sort((a, b) => a - b);
  }
  return { ...state, rounds, order, latest: order[order.length - 1] };
}

function patchPane(state, round, role, mutate) {
  const rounds = new Map(state.rounds);
  const entry = rounds.get(round) || emptyRound();
  rounds.set(round, { ...entry, [role]: mutate({ ...entry[role] }) });
  return { ...state, rounds };
}

function paneFromTurnSnapshot(snapshot, previous = emptyPane(), cumulativeUsage = previous.usage) {
  const text = typeof snapshot.text === 'string' ? snapshot.text : '';
  const tools = Array.isArray(snapshot.tools) ? snapshot.tools : [];
  const parts = text.split('\n');
  const current = parts.pop() ?? '';
  const status = snapshot.status === 'completed'
    ? PaneStatus.Completed
    : snapshot.status === 'failed' || snapshot.status === 'cancelled'
      ? PaneStatus.Failed
      : PaneStatus.Running;
  return {
    status,
    lines: parts,
    current,
    flow: previous.flow,
    tools: tools.map((tool) => ({
      id: tool.id,
      tag: tool.tag,
      name: tool.name,
      title: tool.title || tool.name || tool.id,
      status: tool.status,
      chars: maxFinite(tool.inputChars, tool.outputChars),
      input: previous.tools.find((item) => item.id === tool.id)?.input,
      output: previous.tools.find((item) => item.id === tool.id)?.output,
    })),
    usage: cumulativeUsage ?? previous.usage,
    turnUsage: snapshot.usage ?? previous.turnUsage,
    stopReason: snapshot.stopReason,
    error: snapshot.error,
    chars: text.length,
  };
}

function maxFinite(...values) {
  return values.reduce((max, value) => Number.isFinite(value) ? Math.max(max, value) : max, 0);
}

function appendTextFlow(pane, delta, flowId) {
  if (!delta) return pane;
  const flow = [...pane.flow];
  const last = flow[flow.length - 1];
  if (last?.kind === 'text') {
    flow[flow.length - 1] = { ...last, text: last.text + delta };
  } else {
    flow.push({ id: `flow-${flowId}`, kind: 'text', text: delta });
  }
  return { ...pane, flow };
}

function appendOrUpdateToolFlow(pane, event, flowId) {
  const flow = [...pane.flow];
  const index = flow.findIndex((item) => item.kind === 'tool' && item.toolCallId === event.toolCallId);
  const previous = index >= 0 ? flow[index] : null;
  const next = {
    id: previous?.id ?? `flow-${flowId}`,
    kind: 'tool',
    toolCallId: event.toolCallId,
    tag: event.tag ?? previous?.tag,
    name: event.name ?? previous?.name,
    title: event.title ?? previous?.title,
    status: event.status ?? previous?.status ?? PaneStatus.Running,
    chars: event.chars ?? previous?.chars ?? 0,
    input: event.input ?? previous?.input,
    output: event.output ?? previous?.output,
  };
  if (index >= 0) flow[index] = { ...previous, ...next };
  else flow.push(next);

  const tools = [...pane.tools];
  const toolIndex = tools.findIndex((item) => item.id === event.toolCallId);
  const previousTool = toolIndex >= 0 ? tools[toolIndex] : {};
  const tool = {
    ...previousTool,
    id: event.toolCallId,
    tag: next.tag,
    name: next.name,
    title: next.title,
    status: next.status,
    chars: next.chars,
    input: next.input,
    output: next.output,
  };
  if (toolIndex >= 0) tools[toolIndex] = tool;
  else tools.push(tool);

  return { ...pane, flow, tools };
}

function pushTrace(state, action) {
  const item = boundTraceItem({ id: `trace-${action.traceId}`, role: action.role, entry: action.entry });
  const trace = [
    ...state.trace,
    item,
  ];
  return { ...state, trace: trimTrace(trace) };
}

function trimTrace(trace) {
  const kept = [];
  let bytes = 0;
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const item = trace[index];
    const size = approximateJsonBytes(item);
    if (kept.length >= TRACE_ENTRY_LIMIT) break;
    if (kept.length > 0 && bytes + size > TRACE_TOTAL_BYTES) break;
    kept.push(item);
    bytes += size;
  }
  return kept.reverse();
}

function boundTraceItem(item) {
  if (approximateJsonBytes(item) <= TRACE_ENTRY_BYTES) return item;

  const entry = item.entry && typeof item.entry === 'object'
    ? {
      ...item.entry,
      frame: `[omitted: trace frame exceeded ${TRACE_ENTRY_BYTES} bytes]`,
    }
    : '[omitted: trace entry exceeded size limit]';

  const bounded = { ...item, entry };
  if (approximateJsonBytes(bounded) <= TRACE_ENTRY_BYTES) return bounded;
  return {
    id: item.id,
    role: item.role,
    entry: '[omitted: trace entry exceeded size limit]',
  };
}

function approximateJsonBytes(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return TRACE_ENTRY_BYTES + 1;
  }
}

export function reduce(state, action) {
  switch (action.type) {
    case 'launching':
      return { ...state, phase: Phase.Launching, result: null, startedAt: state.startedAt ?? Date.now() };
    case 'roleStatus':
      return { ...state, statuses: { ...state.statuses, [action.role]: action.message } };
    case 'turnStart': {
      const next = ensureRound({ ...state, phase: Phase.Running, result: null }, action.round);
      return patchPane(next, action.round, action.role, (p) => ({
        ...p,
        status: PaneStatus.Running,
        usage: state.usage[action.role],
        turnUsage: null,
      }));
    }
    case 'turnSnapshot': {
      let next = ensureRound(state, action.round);
      const pane = next.rounds.get(action.round)?.[action.role] ?? emptyPane();
      let roleUsage = next.usage[action.role];
      if (action.snapshot.usage) {
        roleUsage = addUsage(subtractUsage(roleUsage, pane.turnUsage), action.snapshot.usage);
        next = { ...next, usage: { ...next.usage, [action.role]: roleUsage } };
      }
      return patchPane(next, action.round, action.role, (currentPane) =>
        paneFromTurnSnapshot(action.snapshot, currentPane, roleUsage),
      );
    }
    case 'delta':
      return patchPane(ensureRound(state, action.round), action.round, action.role, (pane) =>
        appendTextFlow(pane, action.delta, action.flowId),
      );
    case 'toolStart':
    case 'toolEnd':
      return patchPane(ensureRound(state, action.round), action.round, action.role, (pane) =>
        appendOrUpdateToolFlow(pane, action, action.flowId),
      );
    case 'traceEntry':
      return pushTrace(state, action);
    case 'result':
      return { ...state, phase: Phase.Done, result: action.result, finishedAt: Date.now() };
    case 'error':
      return { ...state, phase: Phase.Error, error: action.error, finishedAt: Date.now() };
    default:
      return state;
  }
}
